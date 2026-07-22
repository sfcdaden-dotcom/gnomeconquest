/**
 * Response-window routing must be driven by card metadata, not by card ids.
 *
 * The router used to hard-code `cardId === 'nope-gnome'` when deciding whether
 * a response card should be told which stack entry it was played against, so
 * a second counter-card could not work without editing the router. These tests
 * register a fixture card and prove the generic path: no engine file mentions
 * the fixture, yet it routes, enumerates and resolves correctly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { GameState } from './index';
import { applyAction, getLegalActions } from './index';
import { CARD_DEFINITIONS, __registerTestCard } from './cards';
import type { WhimsyCardDef } from './cards';
import { pushEvent } from './helpers';
import { mutate, toActionPhase, withGnome, withHand } from './testkit';

/**
 * A second respond-only counter-card. Same contract as Nope-Gnome, expressed
 * purely through the definition: `respondOnly` + `targetsRespondedCard`.
 */
const secondNope: WhimsyCardDef = {
  id: 'test-veto-vole',
  name: 'Veto Vole',
  text: 'Cancel the effects of a Whimsy card as it is played.',
  timing: 'sudden',
  copies: 0, // fixture only: never shuffled into a deck
  respondOnly: true,
  targetsRespondedCard: true,
  needsTargets: false,
  resolve: (d, e) => {
    const idx = e.respondsToStackIndex;
    if (idx === undefined || idx < 0 || idx >= d.cardStack.length) return;
    const victim = d.cardStack[idx];
    victim.cancelled = true;
    pushEvent(d, { type: 'cardCancelled', player: victim.player, cardId: victim.cardId });
  },
};

/** A respond-only card that does NOT counter: it must not get a stack index. */
const respondOnlyNonCounter: WhimsyCardDef = {
  id: 'test-tardy-toad',
  name: 'Tardy Toad',
  text: 'Gain 1 Wish (response only).',
  timing: 'sudden',
  copies: 0,
  respondOnly: true,
  needsTargets: false,
  resolve: (d, e) => {
    d.players[e.player].wishes += 1;
  },
};

const cleanups: Array<() => void> = [];
function register(def: WhimsyCardDef): void {
  cleanups.push(__registerTestCard(def));
}
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Play a card that opens a response window for the opponent. */
function openResponseWindow(seed: number, foeHand: string[]): { s: GameState; me: number; foe: number } {
  let s = toActionPhase(seed);
  const me = s.turn!.activePlayer;
  const foe = me === 0 ? 1 : 0;
  s = withGnome(s, me, { x: 2, y: 3 }).state;
  s = withHand(s, me, 'gnome-birthday-party');
  s = withHand(s, foe, ...foeHand);
  s = applyAction(s, { type: 'playCard', player: me, cardId: 'gnome-birthday-party' });
  return { s, me, foe };
}

describe('respond-only routing is card-definition driven', () => {
  it('a second respondOnly counter-card cancels the card it responds to', () => {
    register(secondNope);
    const { s, me, foe } = openResponseWindow(101, ['test-veto-vole']);

    // The window opened and offers the fixture card — no id list anywhere.
    expect(s.pendingDecision?.kind).toBe('cardResponse');
    expect(s.pendingDecision).toMatchObject({ player: foe, playableCards: ['test-veto-vole'] });
    expect(getLegalActions(s)).toContainEqual({
      type: 'respondPlayCard',
      player: foe,
      cardId: 'test-veto-vole',
    });

    const wishesBefore = s.players[me].wishes;
    const next = applyAction(s, { type: 'respondPlayCard', player: foe, cardId: 'test-veto-vole' });

    // Gnome Birthday Party was cancelled, so its 2 Wishes never arrived.
    expect(next.players[me].wishes).toBe(wishesBefore);
    expect(next.events.some((e) => e.type === 'cardCancelled' && e.cardId === 'gnome-birthday-party')).toBe(true);
    expect(next.cardStack).toHaveLength(0);
  });

  it('records the responded-to stack index generically, from the flag', () => {
    register(secondNope);
    const { s, foe } = openResponseWindow(103, ['test-veto-vole']);
    const stackIndex = (s.pendingDecision as { stackIndex: number }).stackIndex;

    // Freeze the stack mid-resolution by inspecting the entry the router
    // pushed: the fixture card carries the index of the card it answered.
    let seen: number | undefined;
    const spy: WhimsyCardDef = {
      ...secondNope,
      id: 'test-veto-vole-probe',
      resolve: (d, e) => {
        seen = e.respondsToStackIndex;
        secondNope.resolve(d, e);
      },
    };
    register(spy);
    const s2 = mutate(s, (d) => {
      d.players[foe].hand = ['test-veto-vole-probe'];
      if (d.pendingDecision?.kind === 'cardResponse') {
        d.pendingDecision.playableCards = ['test-veto-vole-probe'];
      }
    });
    applyAction(s2, { type: 'respondPlayCard', player: foe, cardId: 'test-veto-vole-probe' });
    expect(seen).toBe(stackIndex);
  });

  it('a respondOnly card without the counter flag gets no stack index', () => {
    register(respondOnlyNonCounter);
    const { s, me, foe } = openResponseWindow(105, ['test-tardy-toad']);
    const wishesBefore = s.players[me].wishes;

    const next = applyAction(s, { type: 'respondPlayCard', player: foe, cardId: 'test-tardy-toad' });

    // It resolved as an ordinary response: nothing was cancelled, so the
    // original card still paid out its 2 Wishes (capped by the wish limit).
    expect(next.events.some((e) => e.type === 'cardCancelled')).toBe(false);
    expect(next.players[me].wishes).toBeGreaterThan(wishesBefore);
  });

  it('respondOnly cards stay unplayable outside a response window', () => {
    register(secondNope);
    let s = toActionPhase(107);
    const me = s.turn!.activePlayer;
    s = withHand(s, me, 'test-veto-vole');

    expect(getLegalActions(s, me).some((a) => a.type === 'playCard' && a.cardId === 'test-veto-vole')).toBe(false);
    expect(() => applyAction(s, { type: 'playCard', player: me, cardId: 'test-veto-vole' })).toThrow(
      /in response/i,
    );
  });

  it('respondOnly cards are excluded from FIGHT respond windows', () => {
    // Fight windows take Sudden Magic but never counter-cards (they have no
    // card to counter) — again decided by the definition, not by id.
    register(secondNope);
    let s = toActionPhase(109);
    const me = s.turn!.activePlayer;
    const foe = me === 0 ? 1 : 0;
    s = withGnome(s, me, { x: 3, y: 2 }).state;
    const foeGnome = withGnome(s, foe, { x: 3, y: 3 });
    s = withHand(foeGnome.state, foe, 'test-veto-vole', 'four-leaf-clover');

    const mine = Object.values(s.units).find((u) => u.owner === me && u.pos.x === 3 && u.pos.y === 2)!;
    s = applyAction(s, { type: 'move', player: me, unitId: mine.id, to: { x: 3, y: 3 } });

    expect(s.pendingDecision?.kind).toBe('fightRespond');
    const playable = (s.pendingDecision as { playableCards: string[] }).playableCards;
    expect(playable).toContain('four-leaf-clover');
    expect(playable).not.toContain('test-veto-vole');
  });

  it('the shipped card list contains exactly one respondOnly card today', () => {
    // Documents the assumption the old router baked in — and that the engine
    // no longer depends on it.
    const respondOnly = CARD_DEFINITIONS.filter((c) => c.respondOnly);
    expect(respondOnly.map((c) => c.id)).toEqual(['nope-gnome']);
    expect(respondOnly.every((c) => c.targetsRespondedCard)).toBe(true);
  });
});
