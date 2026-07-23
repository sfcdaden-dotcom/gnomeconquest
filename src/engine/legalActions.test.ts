/**
 * The legal-action contract, phased-targeting edition:
 *
 *  - `getLegalActionIntents` is the cheap PRIMARY API: one entry per playable
 *    card, no target payloads.
 *  - `getLegalActions` / `enumerateCompleteCardActions` is the expensive
 *    ANALYSIS helper: every targeted card expanded into complete, immediately
 *    executable actions — one per valid `CardTargets` payload — so a fuzzer or
 *    test can dispatch anything it returns without card-specific knowledge.
 *
 * Phased selection itself (one target step at a time) is covered in
 * `targeting.test.ts`; here we pin the enumeration/expansion contract.
 */

import { describe, expect, it } from 'vitest';
import type { Action, GameState } from './index';
import {
  applyAction,
  chooseAiAction,
  createGame,
  enumerateCompleteCardActions,
  getLegalActionIntents,
  getLegalActions,
  isGameOver,
} from './index';
import { CARD_DEFINITIONS, getCardDef } from './cards';
import { mutate, toActionPhase, withGnome, withHand } from './testkit';

/** Cards that need a target payload, by id. */
const TARGETED = CARD_DEFINITIONS.filter((c) => c.needsTargets).map((c) => c.id);

function activeSeat(s: GameState): number {
  return s.turn!.activePlayer;
}

/** Complete targeted plays for one card id (payloads only). */
function payloadsFor(s: GameState, me: number, cardId: string): Array<Action & { type: 'playCard' }> {
  return getLegalActions(s, me).filter(
    (a): a is Action & { type: 'playCard' } => a.type === 'playCard' && a.cardId === cardId,
  );
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

    expect(payloadsFor(s, me, 'instigation')).toHaveLength(0);
    // The untargeted intent still surfaces (the cheap check passes) — dispatching
    // it would open a targeting decision that reports "no legal targets"; it is
    // the COMPLETE expansion that must not offer an unplayable action.
    expect(getLegalActions(s, me).some((a) => a.type === 'playCard' && a.cardId === 'instigation')).toBe(false);
  });
});

describe('getLegalActionIntents (primary, cheap)', () => {
  it('leaves card plays untargeted: one entry per playable card', () => {
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

  it('does not expand a targeted card into multiple actions', () => {
    let s = toActionPhase(31);
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'plot-twist');
    const plotIntents = getLegalActionIntents(s, me).filter(
      (a) => a.type === 'playCard' && a.cardId === 'plot-twist',
    );
    expect(plotIntents).toHaveLength(1);
    expect((plotIntents[0] as { targets?: unknown }).targets).toBeUndefined();
  });
});

describe('complete enumeration (analysis helper)', () => {
  it('getLegalActions and enumerateCompleteCardActions agree', () => {
    let s = toActionPhase(31);
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'rocket-propelled-gnome', 'wild-growth', 'four-leaf-clover', 'plot-twist');
    expect(getLegalActions(s, me)).toEqual(enumerateCompleteCardActions(s, me));
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
    const inst = payloadsFor(s, me, 'instigation').map((p) => p.targets!.units);
    expect(inst).toHaveLength(2);
    expect(inst).toEqual(
      expect.arrayContaining([
        [a.unitId, b.unitId],
        [b.unitId, a.unitId],
      ]),
    );

    // Marriage is symmetric ⇒ one canonical order only.
    expect(payloadsFor(s, me, 'gnomio-and-juliet')).toHaveLength(1);
  });

  it.each([7, 9, 11, 13, 15])('expands Plot Twist to exactly its adjacent pairs on a %i×%i board', (boardSize) => {
    let s = toActionPhase(3, { boardSize });
    const me = activeSeat(s);
    s = withGnome(s, me, { x: 2, y: 2 }).state;
    s = withHand(s, me, 'plot-twist');

    // Phased narrowing means the complete expansion of Plot Twist is exactly
    // the orthogonally adjacent UNORDERED pairs, 2·n·(n-1) of them — NOT the
    // C(n², 2) the old cartesian enumerator walked (which threw at 15×15). So
    // even the expensive analysis helper stays proportional to the real answer.
    expect(payloadsFor(s, me, 'plot-twist')).toHaveLength(2 * boardSize * (boardSize - 1));
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
