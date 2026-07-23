/**
 * Phased card targeting: playing a targeted card WITHOUT targets opens a
 * `cardTargeting` decision, and the engine offers one target step at a time,
 * narrowed by earlier picks. These tests pin the behaviours the phased rewrite
 * promises — per-step options, narrowing, order handling, validation, the
 * no-duplication/no-double-charge transaction model, save round-trips, and that
 * both the AI and response-window cards complete phased targeting.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AiDifficulty, CardTarget, GameState, PlayerId } from './index';
import {
  applyAction,
  chooseAiAction,
  createGame,
  enumerateCompleteCardActions,
  getLegalActionIntents,
  getPendingDecisionOptions,
} from './index';
import { __registerTestCard, type WhimsyCardDef } from './cards';
import { drive, mutate, toActionPhase, withGnome, withHand } from './testkit';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function register(def: WhimsyCardDef): void {
  cleanups.push(__registerTestCard(def));
}

/** A gnome for `me` at (2,2); Plot Twist in hand; then start targeting it. */
function startPlotTwist(seed = 5): { s: GameState; me: PlayerId } {
  let s = toActionPhase(seed);
  const me = s.turn!.activePlayer;
  s = withGnome(s, me, { x: 2, y: 2 }).state;
  s = withHand(s, me, 'plot-twist');
  s = applyAction(s, { type: 'playCard', player: me, cardId: 'plot-twist' });
  return { s, me };
}

const spaceOpt = (x: number, y: number): CardTarget => ({ kind: 'space', pos: { x, y } });

function optionSpaces(s: GameState): string[] {
  return getPendingDecisionOptions(s)
    .filter((o) => o.kind === 'space')
    .map((o) => (o.kind === 'space' ? `${o.pos.x},${o.pos.y}` : ''))
    .sort();
}

// ---------------------------------------------------------------------------
// 1–5: creating the decision, per-step options, narrowing
// ---------------------------------------------------------------------------

describe('starting a targeted play', () => {
  it('creates a cardTargeting decision without removing the card from hand', () => {
    const { s, me } = startPlotTwist();
    expect(s.pendingDecision).toMatchObject({ kind: 'cardTargeting', player: me, cardId: 'plot-twist', stepIndex: 0, stepCount: 2 });
    // The card is still in hand (deferred commit) and not yet in the discard.
    expect(s.players[me].hand).toContain('plot-twist');
    expect(s.discard).not.toContain('plot-twist');
    // No response window has opened — the card has not been played yet.
    expect(s.cardStack).toHaveLength(0);
  });

  it('returns options for the CURRENT step only', () => {
    const { s } = startPlotTwist();
    const opts = getPendingDecisionOptions(s);
    // Step 1 of Plot Twist is a single space pick — every option is a space.
    expect(opts.every((o) => o.kind === 'space')).toBe(true);
    // 7×7 board ⇒ 49 first-space options, and nothing else.
    expect(opts).toHaveLength(49);
  });

  it('narrows the second step to the first pick’s neighbours (Plot Twist)', () => {
    const { s, me } = startPlotTwist();
    // First space: (2,2). Second step must offer only its 4 orth neighbours.
    const s2 = applyAction(s, { type: 'selectTarget', player: me, target: spaceOpt(2, 2) });
    expect(s2.pendingDecision).toMatchObject({ kind: 'cardTargeting', stepIndex: 1, stepCount: 2 });
    expect(optionSpaces(s2)).toEqual(['1,2', '2,1', '2,3', '3,2']);
  });

  it('never materialises the Cartesian pairing list on the normal path', () => {
    const { s, me } = startPlotTwist();
    // Step 1: at most one option per board space, never 2·n·(n-1) pairings.
    expect(getPendingDecisionOptions(s).length).toBeLessThanOrEqual(49);
    const s2 = applyAction(s, { type: 'selectTarget', player: me, target: spaceOpt(2, 2) });
    // Step 2: a handful of neighbours, not the product of both slots.
    expect(getPendingDecisionOptions(s2).length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 6–7: ordered vs unordered
// ---------------------------------------------------------------------------

describe('order handling', () => {
  it('preserves selection order for an ordered card (Instigation: attacker first)', () => {
    let s = toActionPhase(37);
    const me = s.turn!.activePlayer;
    const foe = me === 0 ? 1 : 0;
    const mine = withGnome(s, me, { x: 2, y: 3 });
    const theirs = withGnome(mine.state, foe, { x: 4, y: 3 });
    s = withHand(theirs.state, me, 'instigation');
    s = withHand(s, foe, 'four-leaf-clover'); // opens a response window post-play

    s = applyAction(s, { type: 'playCard', player: me, cardId: 'instigation' });
    // Attacker first (my gnome), then defender (their gnome).
    s = applyAction(s, { type: 'selectTarget', player: me, target: { kind: 'unit', unitId: mine.unitId } });
    s = applyAction(s, { type: 'selectTarget', player: me, target: { kind: 'unit', unitId: theirs.unitId } });

    // The card is now on the stack awaiting the foe's response — inspect the
    // committed payload: attacker (first pick) is units[0].
    const entry = s.cardStack.at(-1)!;
    expect(entry.cardId).toBe('instigation');
    expect(entry.targets?.units).toEqual([mine.unitId, theirs.unitId]);
  });

  it('does not offer a reversed duplicate for an unordered card (Gnomio & Juliet)', () => {
    let s = toActionPhase(41);
    const me = s.turn!.activePlayer;
    s = mutate(s, (d) => {
      for (const u of Object.values(d.units)) delete d.units[u.id];
    });
    const a = withGnome(s, me, { x: 2, y: 3 });
    const b = withGnome(a.state, me, { x: 4, y: 3 });
    s = withHand(b.state, me, 'gnomio-and-juliet');

    // Complete expansion: exactly one payload for the pair, not two.
    const pairs = enumerateCompleteCardActions(s, me).filter(
      (x) => x.type === 'playCard' && x.cardId === 'gnomio-and-juliet',
    );
    expect(pairs).toHaveLength(1);

    // Phased: after picking the first gnome, the second step excludes it (so a
    // single selection sequence can never pick the same gnome twice).
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'gnomio-and-juliet' });
    s = applyAction(s, { type: 'selectTarget', player: me, target: { kind: 'unit', unitId: a.unitId } });
    const step2 = getPendingDecisionOptions(s).filter((o) => o.kind === 'unit');
    expect(step2.map((o) => (o.kind === 'unit' ? o.unitId : ''))).toEqual([b.unitId]);
  });
});

// ---------------------------------------------------------------------------
// 8–10: rejection, staleness, final validation
// ---------------------------------------------------------------------------

describe('validation and safety', () => {
  it('rejects a target that is not a legal option for the current step', () => {
    const { s, me } = startPlotTwist();
    const s2 = applyAction(s, { type: 'selectTarget', player: me, target: spaceOpt(2, 2) });
    // (5,5) is not adjacent to (2,2) — not offered at step 2.
    expect(() => applyAction(s2, { type: 'selectTarget', player: me, target: spaceOpt(5, 5) })).toThrow(
      /not a legal option/i,
    );
    // Wrong-kind pick is likewise rejected.
    expect(() =>
      applyAction(s2, { type: 'selectTarget', player: me, target: { kind: 'player', playerId: me } }),
    ).toThrow(/not a legal option/i);
  });

  it('handles a target invalidated between steps without crashing', () => {
    let s = toActionPhase(53);
    const me = s.turn!.activePlayer;
    const foe = me === 0 ? 1 : 0;
    const mine = withGnome(s, me, { x: 2, y: 3 });
    const theirs = withGnome(mine.state, foe, { x: 4, y: 3 });
    s = withHand(theirs.state, me, 'instigation');
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'instigation' });
    s = applyAction(s, { type: 'selectTarget', player: me, target: { kind: 'unit', unitId: mine.unitId } });

    // The chosen defender pool vanishes underneath the second step.
    const stale = mutate(s, (d) => {
      delete d.units[theirs.unitId];
    });
    // Reading options is safe (no throw) and now yields nothing to pick.
    expect(() => getPendingDecisionOptions(stale)).not.toThrow();
    expect(getPendingDecisionOptions(stale)).toHaveLength(0);
    // The only legal move left is to cancel — which cleanly rolls back.
    expect(getLegalActionIntents(stale, me)).toEqual([{ type: 'cancelTargeting', player: me }]);
    const cancelled = applyAction(stale, { type: 'cancelTargeting', player: me });
    expect(cancelled.pendingDecision).toBeNull();
    expect(cancelled.players[me].hand).toContain('instigation');
  });

  it('runs the card’s final validate before committing (even if steps allowed a pick)', () => {
    // Fixture whose step is looser than its validate: the step offers every
    // seat, but validate forbids targeting yourself. A phased pick of self
    // passes the step yet must be rejected at completion.
    const fixture: WhimsyCardDef = {
      id: 'test-envy',
      name: 'Envy',
      text: 'Target another player (fixture).',
      timing: 'ritual',
      copies: 0,
      needsTargets: true,
      targetFlow: () => [
        {
          kind: 'player',
          prompt: 'Choose a player',
          getOptions: (st) => st.players.map((p) => ({ kind: 'player', playerId: p.id })),
        },
      ],
      validate: (_st, p, t) => (t?.players?.[0] === p ? 'you cannot target yourself' : null),
      resolve: () => {},
    };
    register(fixture);
    let s = toActionPhase(59);
    const me = s.turn!.activePlayer;
    s = withHand(s, me, 'test-envy');
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'test-envy' });
    // Self IS offered by the (loose) step…
    expect(getPendingDecisionOptions(s).some((o) => o.kind === 'player' && o.playerId === me)).toBe(true);
    // …but committing it trips the final validate.
    expect(() => applyAction(s, { type: 'selectTarget', player: me, target: { kind: 'player', playerId: me } })).toThrow(
      /cannot target yourself/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 11–12: transaction model, serialization
// ---------------------------------------------------------------------------

describe('transaction model', () => {
  it('does not duplicate, lose, or double-charge the card across cancel + replay', () => {
    let s = toActionPhase(61);
    const me = s.turn!.activePlayer;
    s = withGnome(s, me, { x: 2, y: 2 }).state;
    s = withHand(s, me, 'plot-twist');
    const wishes = s.players[me].wishes;
    const handCount = s.players[me].hand.filter((c) => c === 'plot-twist').length;
    const discardCount = s.discard.filter((c) => c === 'plot-twist').length;

    // Start → cancel: nothing moved, nothing charged.
    let t = applyAction(s, { type: 'playCard', player: me, cardId: 'plot-twist' });
    t = applyAction(t, { type: 'cancelTargeting', player: me });
    expect(t.players[me].hand.filter((c) => c === 'plot-twist')).toHaveLength(handCount);
    expect(t.discard.filter((c) => c === 'plot-twist')).toHaveLength(discardCount);
    expect(t.players[me].wishes).toBe(wishes);
    expect(t.pendingDecision).toBeNull();

    // Start → complete: the card leaves the hand exactly once, to the discard.
    t = applyAction(t, { type: 'playCard', player: me, cardId: 'plot-twist' });
    t = applyAction(t, { type: 'selectTarget', player: me, target: spaceOpt(2, 2) });
    t = applyAction(t, { type: 'selectTarget', player: me, target: spaceOpt(2, 3) });
    expect(t.players[me].hand.filter((c) => c === 'plot-twist')).toHaveLength(handCount - 1);
    expect(t.discard.filter((c) => c === 'plot-twist')).toHaveLength(discardCount + 1);
    expect(t.players[me].wishes).toBe(wishes); // playing a card is free
  });

  it('blocks starting another card while one is mid-targeting', () => {
    let s = toActionPhase(63);
    const me = s.turn!.activePlayer;
    s = withGnome(s, me, { x: 2, y: 2 }).state;
    s = withHand(s, me, 'plot-twist', 'rocket-propelled-gnome');
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'plot-twist' });
    expect(() => applyAction(s, { type: 'playCard', player: me, cardId: 'rocket-propelled-gnome' })).toThrow();
    // Normal turn actions are blocked too (a pending decision is open).
    expect(() => applyAction(s, { type: 'endTurn', player: me })).toThrow();
  });

  it('survives a JSON save/load round-trip mid-targeting', () => {
    const { s, me } = startPlotTwist();
    const s1 = applyAction(s, { type: 'selectTarget', player: me, target: spaceOpt(2, 2) });
    const roundTripped: GameState = JSON.parse(JSON.stringify(s1));
    expect(roundTripped).toEqual(s1);
    // Options recompute identically, and the loaded game continues cleanly.
    expect(optionSpaces(roundTripped)).toEqual(optionSpaces(s1));
    const before = applyAction(s1, { type: 'selectTarget', player: me, target: spaceOpt(2, 3) });
    const after = applyAction(roundTripped, { type: 'selectTarget', player: me, target: spaceOpt(2, 3) });
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
  });
});

// ---------------------------------------------------------------------------
// 13–15: AI, response cards, determinism/immutability
// ---------------------------------------------------------------------------

describe('AI and response windows', () => {
  it.each<AiDifficulty>(['easy', 'normal', 'hard'])('AI completes phased targeting (%s)', (difficulty) => {
    const players = [
      { name: 'A', controller: 'cpu' as const, difficulty },
      { name: 'B', controller: 'cpu' as const, difficulty },
    ];
    let s = createGame({ players }, 5);
    s = drive(s, (x) => x.status === 'playing' && !x.pendingDecision && x.turn?.phase === 'action');
    const me = s.turn!.activePlayer;
    s = withGnome(s, me, { x: 2, y: 2 }).state;
    s = withHand(s, me, 'plot-twist');
    // Force the CPU into a phased decision (its own planner would pre-target).
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'plot-twist' });
    expect(s.pendingDecision?.kind).toBe('cardTargeting');

    let guard = 0;
    while (s.pendingDecision?.kind === 'cardTargeting') {
      s = applyAction(s, chooseAiAction(s));
      if (++guard > 10) throw new Error('AI failed to complete phased targeting');
    }
    // The card was actually played (committed to the discard).
    expect(s.players[me].hand).not.toContain('plot-twist');
    expect(s.discard).toContain('plot-twist');
  });

  it('completes phased targeting for a card played in a response window', () => {
    let s = toActionPhase(71);
    const me = s.turn!.activePlayer;
    const foe = me === 0 ? 1 : 0;
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'gnome-birthday-party');
    s = withHand(s, foe, 'snake-eyes'); // targeted Sudden card, playable in response

    s = applyAction(s, { type: 'playCard', player: me, cardId: 'gnome-birthday-party' });
    expect(s.pendingDecision?.kind).toBe('cardResponse');

    // Foe responds with a card that needs a target → phased targeting opens,
    // carrying the response context.
    s = applyAction(s, { type: 'respondPlayCard', player: foe, cardId: 'snake-eyes' });
    expect(s.pendingDecision).toMatchObject({ kind: 'cardTargeting', player: foe, cardId: 'snake-eyes' });

    // Pick a target player and let it resolve; Snake Eyes docks their roll.
    s = applyAction(s, { type: 'selectTarget', player: foe, target: { kind: 'player', playerId: me } });
    expect(s.rollModifiers[me]).toBe(-2);
    expect(s.pendingDecision?.kind).not.toBe('cardTargeting');
  });

  it('cancelling a response-window targeting restores that window', () => {
    let s = toActionPhase(73);
    const me = s.turn!.activePlayer;
    const foe = me === 0 ? 1 : 0;
    s = withGnome(s, me, { x: 2, y: 3 }).state;
    s = withHand(s, me, 'gnome-birthday-party');
    s = withHand(s, foe, 'snake-eyes');
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'gnome-birthday-party' });
    s = applyAction(s, { type: 'respondPlayCard', player: foe, cardId: 'snake-eyes' });
    expect(s.pendingDecision?.kind).toBe('cardTargeting');

    const back = applyAction(s, { type: 'cancelTargeting', player: foe });
    expect(back.pendingDecision).toMatchObject({ kind: 'cardResponse', player: foe });
    expect(back.players[foe].hand).toContain('snake-eyes'); // never left the hand
  });

  it('applyAction never mutates its input during targeting (immutability)', () => {
    const { s, me } = startPlotTwist();
    const snapshot = JSON.stringify(s);
    applyAction(s, { type: 'selectTarget', player: me, target: spaceOpt(2, 2) });
    applyAction(s, { type: 'cancelTargeting', player: me });
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('phased targeting replays deterministically', () => {
    const seq = (): GameState => {
      const start = startPlotTwist(83);
      let s = start.s;
      s = applyAction(s, { type: 'selectTarget', player: start.me, target: spaceOpt(2, 2) });
      s = applyAction(s, { type: 'selectTarget', player: start.me, target: spaceOpt(2, 3) });
      return s;
    };
    expect(JSON.parse(JSON.stringify(seq()))).toEqual(JSON.parse(JSON.stringify(seq())));
  });
});
