/**
 * The legal-action contract:
 *   everything getLegalActions returns must be directly executable by
 *   applyAction, targets included.
 *
 * These tests are the guard rail for that promise — the previous API handed
 * back `playCard` / `respondPlayCard` actions with no target payload, which a
 * caller could not dispatch without card-specific knowledge.
 */

import { describe, expect, it } from 'vitest';
import type { Action, GameState } from './index';
import {
  MAX_TARGET_COMBINATIONS,
  applyAction,
  chooseAiAction,
  createGame,
  getLegalActionIntents,
  getLegalActions,
  getTargetOptions,
  isGameOver,
} from './index';
import { CARD_DEFINITIONS, getCardDef } from './cards';
import { mutate, toActionPhase, withGnome, withHand } from './testkit';

/** Cards that need a target payload, by id. */
const TARGETED = CARD_DEFINITIONS.filter((c) => c.needsTargets).map((c) => c.id);

function activeSeat(s: GameState): number {
  return s.turn!.activePlayer;
}

describe('getLegalActions returns executable actions', () => {
  it('every enumerated action applies cleanly at the opening Action Phase', () => {
    const s = toActionPhase(11);
    const actions = getLegalActions(s);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(() => applyAction(s, a), `action ${JSON.stringify(a)} should be executable`).not.toThrow();
    }
  });

  it('every enumerated action applies cleanly across a whole AI game', () => {
    let s: GameState = createGame(
      {
        players: [
          { name: 'A', controller: 'cpu' },
          { name: 'B', controller: 'cpu' },
        ],
      },
      2024,
    );
    let checked = 0;
    for (let i = 0; i < 400 && !isGameOver(s); i++) {
      for (const a of getLegalActions(s)) {
        expect(() => applyAction(s, a), `action ${JSON.stringify(a)} should be executable`).not.toThrow();
        checked += 1;
      }
      s = applyAction(s, chooseAiAction(s));
    }
    expect(checked).toBeGreaterThan(500);
  }, 120_000);

  it('targeted cards are enumerated WITH targets, and each one is executable', () => {
    // A hand of every targeted card at once: each play must arrive complete.
    let s = toActionPhase(7);
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withGnome(s, me === 0 ? 1 : 0, { x: 4, y: 3 }).state;
    s = withHand(s, me, ...TARGETED);
    s = mutate(s, (d) => {
      d.discard.push('four-leaf-clover'); // gives Another Gnomes Treasure a target
    });

    const plays = getLegalActions(s, me).filter((a) => a.type === 'playCard');
    expect(plays.length).toBeGreaterThan(0);
    for (const a of plays) {
      if (a.type !== 'playCard') continue;
      const def = getCardDef(a.cardId);
      if (def?.needsTargets) {
        expect(a.targets, `${a.cardId} should carry targets`).toBeDefined();
      }
      expect(() => applyAction(s, a), `${a.cardId} ${JSON.stringify(a.targets)}`).not.toThrow();
    }
    // At least one genuinely targeted card made it into the enumeration.
    expect(plays.some((a) => a.type === 'playCard' && a.targets !== undefined)).toBe(true);
  });

  it('enumerates response-window plays with targets too', () => {
    let s = toActionPhase(19);
    const me = activeSeat(s);
    const foe = me === 0 ? 1 : 0;
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'gnome-birthday-party');
    s = withHand(s, foe, 'snake-eyes'); // targeted Sudden card, playable in response

    s = applyAction(s, { type: 'playCard', player: me, cardId: 'gnome-birthday-party' });
    expect(s.pendingDecision?.kind).toBe('cardResponse');

    const responses = getLegalActions(s).filter((a) => a.type === 'respondPlayCard');
    expect(responses.length).toBeGreaterThan(0);
    for (const a of responses) {
      if (a.type !== 'respondPlayCard') continue;
      expect(a.targets, `${a.cardId} response should carry targets`).toBeDefined();
      expect(() => applyAction(s, a)).not.toThrow();
    }
  });

  it('drops a targeted card that has no valid target instead of offering it', () => {
    // Instigation needs two gnomes with different owners; with only our own
    // gnome on the board there is no valid payload, so no action is offered.
    let s = toActionPhase(23);
    const me = activeSeat(s);
    s = mutate(s, (d) => {
      for (const u of Object.values(d.units)) delete d.units[u.id];
    });
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'instigation');

    expect(getTargetOptions(s, { type: 'playCard', player: me, cardId: 'instigation' })).toHaveLength(0);
    expect(getLegalActions(s, me).some((a) => a.type === 'playCard' && a.cardId === 'instigation')).toBe(false);
  });
});

describe('getLegalActions / getLegalActionIntents / getTargetOptions', () => {
  it('getLegalActions is exactly the intents expanded by their target options', () => {
    let s = toActionPhase(31);
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'rocket-propelled-gnome', 'wild-growth', 'four-leaf-clover');

    const expanded: Action[] = [];
    for (const intent of getLegalActionIntents(s, me)) {
      if (intent.type !== 'playCard' && intent.type !== 'respondPlayCard') {
        expanded.push(intent);
        continue;
      }
      const opts = getTargetOptions(s, intent);
      if (opts.length === 0) {
        if (!getCardDef(intent.cardId)?.needsTargets) expanded.push(intent);
        continue;
      }
      for (const targets of opts) expanded.push({ ...intent, targets });
    }
    expect(getLegalActions(s, me)).toEqual(expanded);
  });

  it('intents stay cheap: one entry per playable card, no target payloads', () => {
    let s = toActionPhase(31);
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'rocket-propelled-gnome');

    const intents = getLegalActionIntents(s, me).filter(
      (a) => a.type === 'playCard' && a.cardId === 'rocket-propelled-gnome',
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]).toEqual({ type: 'playCard', player: me, cardId: 'rocket-propelled-gnome' });
  });

  it('returns no target options for untargeted cards', () => {
    const s = toActionPhase(5);
    const me = activeSeat(s);
    expect(getTargetOptions(s, { type: 'playCard', player: me, cardId: 'four-leaf-clover' })).toEqual([]);
  });

  it('enumerates both orders for an ordered slot and one for an unordered slot', () => {
    let s = toActionPhase(37);
    const me = activeSeat(s);
    const foe = me === 0 ? 1 : 0;
    s = mutate(s, (d) => {
      for (const u of Object.values(d.units)) delete d.units[u.id];
    });
    const a = withGnome(s, me, { x: 2, y: 3 });
    const b = withGnome(a.state, foe, { x: 4, y: 3 });
    s = withHand(b.state, me, 'instigation', 'gnomio-and-juliet');

    // Instigation's first target is the attacker ⇒ both orders are real plays.
    const inst = getTargetOptions(s, { type: 'playCard', player: me, cardId: 'instigation' });
    expect(inst).toHaveLength(2);
    expect(inst.map((t) => t.units)).toEqual(
      expect.arrayContaining([
        [a.unitId, b.unitId],
        [b.unitId, a.unitId],
      ]),
    );

    // Marriage is symmetric ⇒ one canonical order only.
    const wed = getTargetOptions(s, { type: 'playCard', player: me, cardId: 'gnomio-and-juliet' });
    expect(wed).toHaveLength(1);
  });

  it('no shipped card overruns the enumeration budget on a large board', () => {
    // 11×11 is the largest board the setup UI can produce; the widest card
    // (two spaces) is C(121,2) = 7,260 combinations.
    let s = toActionPhase(3, { boardSize: 11 });
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 5, y: 5 }).state;
    s = withHand(s, me, ...TARGETED);
    s = mutate(s, (d) => d.discard.push('four-leaf-clover'));

    for (const cardId of TARGETED) {
      const opts = getTargetOptions(s, { type: 'playCard', player: me, cardId });
      expect(opts.length, `${cardId} enumeration should not be truncated`).toBeLessThan(
        MAX_TARGET_COMBINATIONS,
      );
    }
  });
});

describe('enumeration is pure and deterministic', () => {
  it('does not mutate the state it inspects', () => {
    let s = toActionPhase(41);
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, ...TARGETED);
    const before = JSON.stringify(s);
    getLegalActions(s, me);
    getLegalActionIntents(s, me);
    for (const cardId of TARGETED) getTargetOptions(s, { type: 'playCard', player: me, cardId });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('returns an identical, JSON-serializable enumeration for an identical state', () => {
    let s = toActionPhase(43);
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'plot-twist', 'wild-growth');
    const once = getLegalActions(s, me);
    const twice = getLegalActions(structuredClone(s), me);
    expect(JSON.parse(JSON.stringify(once))).toEqual(JSON.parse(JSON.stringify(twice)));
  });
});
