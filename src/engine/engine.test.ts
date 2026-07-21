/**
 * Engine test suite.
 *
 * Because GameState is plain JSON-serializable data (an engine contract),
 * tests may hand-craft scenarios by cloning a state and mutating the clone
 * (`mutate`, `withGnome`) — the engine never trusts prior state shape beyond
 * its documented invariants.
 *
 * The AI-vs-AI smoke tests are the backbone: a seeded game driven entirely by
 * `chooseAiAction` must reach `finished` without a single engine error.
 */

import { describe, expect, it } from 'vitest';
import type { CreateGameOptions, GameState } from './index';
import {
  EngineError,
  applyAction,
  chooseAiAction,
  createGame,
  getLegalActions,
  isGameOver,
} from './index';
import {
  activePlayer,
  drive,
  mutate,
  newGame,
  toActionPhase,
  totalGnomes,
  withGnome,
} from './testkit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cheap structural invariants that must hold in ANY reachable state. */
function checkInvariants(s: GameState): void {
  const n = s.config.boardSize;
  for (const u of Object.values(s.units)) {
    expect(u.pos.x).toBeGreaterThanOrEqual(0);
    expect(u.pos.y).toBeGreaterThanOrEqual(0);
    expect(u.pos.x).toBeLessThan(n);
    expect(u.pos.y).toBeLessThan(n);
  }
  for (const count of Object.values(s.supply)) {
    expect(count).toBeGreaterThanOrEqual(0);
  }
  for (const p of s.players) {
    expect(p.wishes).toBeGreaterThanOrEqual(0);
    expect(p.gnomesSpawned).toBeLessThanOrEqual(s.config.totalReinforcements);
    expect(p.gnomesLost).toBeLessThanOrEqual(p.gnomesSpawned);
  }
  expect(s.cardStack.length === 0 || s.pendingDecision !== null || s.status === 'finished').toBe(true);
}

// ---------------------------------------------------------------------------
// createGame
// ---------------------------------------------------------------------------

describe('createGame', () => {
  it('rejects invalid configurations', () => {
    const p = { name: 'X', controller: 'cpu' as const };
    expect(() => createGame({ players: [p, p, p] }, 1)).toThrow(EngineError);
    expect(() => createGame({ players: [p, p], boardSize: 6 }, 1)).toThrow(EngineError);
    expect(() => createGame({ players: [p, p], boardSize: 5, gardenPreset: 'few' }, 1)).toThrow(EngineError);
    expect(() => createGame({ players: [p, p], startingWishes: 9, wishLimit: 5 }, 1)).toThrow(EngineError);
  });

  it('builds the documented initial state', () => {
    const s = newGame(7, { gardenPreset: 'many' }, 4);
    expect(s.status).toBe('rolloff');
    expect(s.pendingDecision).toEqual({ kind: 'rollOff', player: 0 });
    expect(s.deck).toHaveLength(46); // 2 × 23 whimsy cards
    expect(s.cursePool).toHaveLength(5);
    expect(s.players).toHaveLength(4);
    expect(s.rollModifiers).toEqual([0, 0, 0, 0]);
    // 'many' preset: 4 homes + 16 preset gardens.
    expect(Object.keys(s.gardens)).toHaveLength(20);
    expect(s.supply.tunnel).toBe(4); // 8 − 4 preset tunnels
  });

  it('accepts a custom garden layout, bypassing the built-in preset registry', () => {
    const p = { name: 'X', controller: 'cpu' as const };
    const s = createGame(
      {
        players: [p, p],
        boardSize: 7,
        gardenPreset: 'custom:example',
        customGardens: [
          { pos: { x: 1, y: 1 }, type: 'dandelion' },
          { pos: { x: 5, y: 5 }, type: 'maize' },
        ],
      },
      1,
    );
    expect(s.config.customGardens).toEqual([
      { pos: { x: 1, y: 1 }, type: 'dandelion' },
      { pos: { x: 5, y: 5 }, type: 'maize' },
    ]);
    expect(s.gardens['1,1'].type).toBe('dandelion');
    expect(s.gardens['5,5'].type).toBe('maize');
    expect(s.supply.dandelion).toBe(7);
    expect(s.supply.maize).toBe(7);
  });

  it('rejects a custom layout that collides with a Home Garden space', () => {
    const p = { name: 'X', controller: 'cpu' as const };
    expect(() =>
      createGame(
        { players: [p, p], boardSize: 7, customGardens: [{ pos: { x: 0, y: 3 }, type: 'tunnel' }] },
        1,
      ),
    ).toThrow(EngineError);
  });

  it('rejects a custom layout with an out-of-bounds or duplicate position', () => {
    const p = { name: 'X', controller: 'cpu' as const };
    expect(() =>
      createGame(
        { players: [p, p], boardSize: 7, customGardens: [{ pos: { x: 9, y: 9 }, type: 'tunnel' }] },
        1,
      ),
    ).toThrow(EngineError);
    expect(() =>
      createGame(
        {
          players: [p, p],
          boardSize: 7,
          customGardens: [
            { pos: { x: 1, y: 1 }, type: 'tunnel' },
            { pos: { x: 1, y: 1 }, type: 'maize' },
          ],
        },
        1,
      ),
    ).toThrow(EngineError);
  });

  it('accepts custom Home Garden positions', () => {
    const p = { name: 'X', controller: 'cpu' as const };
    const s = createGame(
      { players: [p, p], boardSize: 7, customHomes: [{ x: 2, y: 2 }, { x: 4, y: 4 }] },
      1,
    );
    expect(s.players[0].homePos).toEqual({ x: 2, y: 2 });
    expect(s.players[1].homePos).toEqual({ x: 4, y: 4 });
    expect(s.gardens['2,2'].type).toBe('home');
    expect(s.gardens['4,4'].type).toBe('home');
  });

  it('rejects customHomes with the wrong count for the seating', () => {
    const p = { name: 'X', controller: 'cpu' as const };
    expect(() =>
      createGame({ players: [p, p], boardSize: 7, customHomes: [{ x: 2, y: 2 }] }, 1),
    ).toThrow(EngineError);
    expect(() =>
      createGame(
        { players: [p, p, p, p], boardSize: 7, customHomes: [{ x: 2, y: 2 }, { x: 4, y: 4 }] },
        1,
      ),
    ).toThrow(EngineError);
  });

  it('rejects duplicate or out-of-bounds customHomes positions', () => {
    const p = { name: 'X', controller: 'cpu' as const };
    expect(() =>
      createGame(
        { players: [p, p], boardSize: 7, customHomes: [{ x: 2, y: 2 }, { x: 2, y: 2 }] },
        1,
      ),
    ).toThrow(EngineError);
    expect(() =>
      createGame(
        { players: [p, p], boardSize: 7, customHomes: [{ x: 2, y: 2 }, { x: 9, y: 9 }] },
        1,
      ),
    ).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// Core loop regressions
// ---------------------------------------------------------------------------

describe('turn lifecycle', () => {
  it('survives the roll-off into a playable first Action Phase', () => {
    const s = toActionPhase(1);
    expect(s.status).toBe('playing');
    expect(s.turn?.number).toBe(1);
    const legal = getLegalActions(s);
    expect(legal.some((a) => a.type === 'endTurn')).toBe(true);
  });

  it('is deterministic: same seed + same policy ⇒ identical states', () => {
    const run = () => drive(newGame(7, { gardenPreset: 'many' }), () => false, 300);
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('diverges across different seeds', () => {
    const a = drive(newGame(21, { gardenPreset: 'few' }), () => false, 150);
    const b = drive(newGame(22, { gardenPreset: 'few' }), () => false, 150);
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events));
  });

  it('applyAction never mutates its input', () => {
    let s = newGame(19, { gardenPreset: 'few' });
    for (let i = 0; i < 30 && !isGameOver(s); i++) {
      const snapshot = JSON.stringify(s);
      const next = applyAction(s, chooseAiAction(s));
      expect(JSON.stringify(s)).toBe(snapshot);
      expect(next).not.toBe(s);
      s = next;
    }
  });

  it('stays JSON-serializable mid-game', () => {
    const s = drive(newGame(3, { gardenPreset: 'few' }), () => false, 200);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

// ---------------------------------------------------------------------------
// Fights
// ---------------------------------------------------------------------------

describe('fights', () => {
  it('entering an enemy-occupied space fights until one side is destroyed', () => {
    let s = toActionPhase(11);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    const a = withGnome(s, me, { x: 2, y: 1 });
    const b = withGnome(a.state, foe, { x: 3, y: 1 });
    s = b.state;
    const before = totalGnomes(s);
    s = applyAction(s, { type: 'move', player: me, unitId: a.unitId, to: { x: 3, y: 1 } });
    expect(s.fight).toBeNull();
    expect(totalGnomes(s)).toBe(before - 1);
    expect(s.events.some((e) => e.type === 'fightStarted')).toBe(true);
    expect(s.events.some((e) => e.type === 'unitDestroyed' && e.cause === 'fight')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Card stack
// ---------------------------------------------------------------------------

describe('card stack', () => {
  it('plays and resolves a simple card through the settle loop', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      d.players[me].hand.push('gnome-birthday-party');
      d.players[me].wishes = 2;
    });
    expect(getLegalActions(s).some((a) => a.type === 'playCard' && a.cardId === 'gnome-birthday-party')).toBe(true);
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'gnome-birthday-party' });
    expect(s.cardStack).toHaveLength(0);
    expect(s.players[me].wishes).toBe(4);
    expect(s.discard).toContain('gnome-birthday-party');
    expect(s.events.some((e) => e.type === 'cardResolved')).toBe(true);
  });

  it('opens a response window and lets Nope-Gnome cancel the card', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    s = mutate(s, (d) => {
      d.players[me].hand.push('gnome-birthday-party');
      d.players[me].wishes = 2;
      d.players[foe].hand.push('nope-gnome');
    });
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'gnome-birthday-party' });
    // The opponent holds a playable Sudden card ⇒ a cardResponse window opens.
    expect(s.pendingDecision).toMatchObject({ kind: 'cardResponse', player: foe });
    const legal = getLegalActions(s);
    expect(legal).toContainEqual({ type: 'respondPass', player: foe });
    expect(legal).toContainEqual({ type: 'respondPlayCard', player: foe, cardId: 'nope-gnome' });

    s = applyAction(s, { type: 'respondPlayCard', player: foe, cardId: 'nope-gnome' });
    expect(s.cardStack).toHaveLength(0);
    expect(s.players[me].wishes).toBe(2); // cancelled: no wishes gained
    expect(s.events.some((e) => e.type === 'cardCancelled' && e.cardId === 'gnome-birthday-party')).toBe(true);
  });

  it('passing the response window resolves the card normally', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    s = mutate(s, (d) => {
      d.players[me].hand.push('gnome-birthday-party');
      d.players[me].wishes = 0;
      d.players[foe].hand.push('nope-gnome');
    });
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'gnome-birthday-party' });
    s = applyAction(s, { type: 'respondPass', player: foe });
    expect(s.players[me].wishes).toBe(2);
    expect(s.players[foe].hand).toContain('nope-gnome'); // kept for later
  });
});

// ---------------------------------------------------------------------------
// Timed effects
// ---------------------------------------------------------------------------

describe('timed effects', () => {
  it('Great Wall blocks entry and expires at the start of the caster’s next turn', () => {
    let s = toActionPhase(9, { gardenPreset: 'few' });
    const me = activePlayer(s);
    const wallPos = { x: 1, y: 1 }; // a preset tunnel garden
    const g = withGnome(s, me, { x: 1, y: 2 });
    s = mutate(g.state, (d) => {
      d.players[me].hand.push('great-wall-of-whimsy');
    });
    s = applyAction(s, {
      type: 'playCard',
      player: me,
      cardId: 'great-wall-of-whimsy',
      targets: { spaces: [wallPos] },
    });
    expect(s.timedEffects).toHaveLength(1);

    // The walled space is not a legal move destination, and doMove refuses it.
    const moves = getLegalActions(s).filter((a) => a.type === 'move' && a.unitId === g.unitId);
    expect(moves.some((a) => a.type === 'move' && a.to.x === 1 && a.to.y === 1)).toBe(false);
    expect(() =>
      applyAction(s, { type: 'move', player: me, unitId: g.unitId, to: wallPos }),
    ).toThrow(/Great Wall/);

    // End the turn; after the opponent's full turn, the caster's turn starts
    // again and the wall expires.
    const startTurnNo = s.turn?.number ?? 0;
    s = applyAction(s, { type: 'endTurn', player: me });
    s = drive(s, (x) => x.status === 'finished' || (x.turn !== null && x.turn.activePlayer === me && x.turn.number > startTurnNo), 500);
    expect(s.timedEffects).toHaveLength(0);
    expect(s.events.some((e) => e.type === 'timedEffectExpired' && e.kind === 'greatWall')).toBe(true);
  });

  it('Lost In The Maize traps gnomes on active Maize Gardens', () => {
    let s = toActionPhase(9);
    const me = activePlayer(s);
    const maizePos = { x: 2, y: 2 };
    const g = withGnome(s, me, maizePos);
    s = mutate(g.state, (d) => {
      d.gardens['2,2'] = { type: 'maize', plantedOnTurn: 0, stunnedForPlayerTurn: null, doubledForPlayerTurn: null };
      d.players[me].wishes = 5; // exit cost is affordable — the lock still wins
      d.players[me].hand.push('lost-in-the-maize');
    });
    // Payable exit ⇒ movable before the card.
    expect(getLegalActions(s).some((a) => a.type === 'move' && a.unitId === g.unitId)).toBe(true);
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'lost-in-the-maize' });
    expect(getLegalActions(s).some((a) => a.type === 'move' && a.unitId === g.unitId)).toBe(false);
    expect(() =>
      applyAction(s, { type: 'move', player: me, unitId: g.unitId, to: { x: 3, y: 2 } }),
    ).toThrow(/Maize/);
  });
});

// ---------------------------------------------------------------------------
// Curses
// ---------------------------------------------------------------------------

describe('curses', () => {
  it('Compost Combustion doubles the planting cost', () => {
    let s = toActionPhase(13);
    const me = activePlayer(s);
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = mutate(g.state, (d) => {
      d.activeCurses.push('curse-compost-combustion');
      d.players[me].wishes = 1;
    });
    expect(getLegalActions(s).some((a) => a.type === 'plant')).toBe(false);
    expect(() =>
      applyAction(s, { type: 'plant', player: me, pos: { x: 2, y: 2 }, gardenType: 'dandelion' }),
    ).toThrow(/2 Wish/);

    s = mutate(s, (d) => {
      d.players[me].wishes = 2;
    });
    s = applyAction(s, { type: 'plant', player: me, pos: { x: 2, y: 2 }, gardenType: 'dandelion' });
    expect(s.players[me].wishes).toBe(0);
    expect(s.gardens['2,2']?.type).toBe('dandelion');
  });

  it('Magic Drain demands a sacrifice when starting a turn at 0 Wishes', () => {
    let s = toActionPhase(13);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    const g = withGnome(s, foe, { x: 4, y: 4 });
    s = mutate(g.state, (d) => {
      d.activeCurses.push('curse-magic-drain');
      d.players[foe].wishes = 0;
    });
    s = applyAction(s, { type: 'endTurn', player: me });
    expect(s.pendingDecision).toMatchObject({ kind: 'sacrificeGnome', player: foe });
    const legal = getLegalActions(s);
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((a) => a.type === 'sacrificeGnome')).toBe(true);
    const before = totalGnomes(s);
    s = applyAction(s, legal[0]);
    expect(totalGnomes(s)).toBe(before - 1);
    expect(s.events.some((e) => e.type === 'unitDestroyed' && e.cause === 'magic-drain')).toBe(true);
  });

  it('Antsy Pants forbids ending the turn while a gnome can still move', () => {
    let s = toActionPhase(13);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      d.activeCurses.push('curse-antsy-pants');
    });
    const movable = getLegalActions(s).filter((a) => a.type === 'move');
    expect(movable.length).toBeGreaterThan(0); // AI took a home-harvest gnome
    expect(getLegalActions(s).some((a) => a.type === 'endTurn')).toBe(false);
    expect(() => applyAction(s, { type: 'endTurn', player: me })).toThrow(/Antsy Pants/);

    // Move every movable gnome; then the turn may end.
    while (true) {
      const mv = getLegalActions(s).find((a) => a.type === 'move');
      if (!mv) break;
      s = applyAction(s, mv);
      if (s.pendingDecision) s = drive(s, (x) => !x.pendingDecision, 50);
    }
    expect(getLegalActions(s).some((a) => a.type === 'endTurn')).toBe(true);
  });

  it('Mulch Fever hands ties to the attacker instead of rerolling', () => {
    // Seed-independent check via events: under Mulch Fever no roll is ever
    // logged as a tie-with-reroll (each round logs exactly one final roll).
    let s = toActionPhase(17);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    const a = withGnome(s, me, { x: 2, y: 1 });
    const b = withGnome(a.state, foe, { x: 3, y: 1 });
    s = mutate(b.state, (d) => {
      d.activeCurses.push('curse-mulch-fever');
    });
    s = applyAction(s, { type: 'move', player: me, unitId: a.unitId, to: { x: 3, y: 1 } });
    const rolls = s.events.filter((e) => e.type === 'fightRolled');
    expect(rolls.length).toBeGreaterThan(0);
    // With Mulch Fever a tie ends the round (attacker wins) — ties never repeat.
    for (let i = 0; i < rolls.length - 1; i++) {
      const r = rolls[i];
      if (r.type === 'fightRolled' && r.tie) {
        // a tie must be the round's last roll, so the next event is not a reroll
        const next = rolls[i + 1];
        expect(next.type === 'fightRolled' && next.round === r.round).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AI policies
// ---------------------------------------------------------------------------

describe('AI policies', () => {
  it('declines an optional entry hop that does not strictly improve (no tunnel ping-pong)', () => {
    // Regression: two tunnels equidistant from the AI's target used to
    // ping-pong forever via chained optional entry effects (stall at turn ~6).
    let s = toActionPhase(11);
    const me = activePlayer(s);
    const g = withGnome(s, me, { x: 5, y: 1 });
    s = mutate(g.state, (d) => {
      const blank = { plantedOnTurn: 0, stunnedForPlayerTurn: null, doubledForPlayerTurn: null };
      d.gardens['5,1'] = { type: 'tunnel', ...blank };
      d.gardens['5,5'] = { type: 'tunnel', ...blank };
      // Both tunnels are manhattan-3 from the enemy home at (6,3) / (0,3).
      d.pendingDecision = {
        kind: 'tunnel',
        player: me,
        unitId: g.unitId,
        from: { x: 5, y: 1 },
        options: [{ x: 5, y: 5 }],
        optional: true,
        context: 'entry',
      };
    });
    expect(chooseAiAction(s)).toEqual({ type: 'declineEffect', player: me });
  });
});

// ---------------------------------------------------------------------------
// AI card play & respond policies
// ---------------------------------------------------------------------------

describe('AI card play', () => {
  it('discards the lowest static-value card when over the hand limit', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      d.pendingDecision = { kind: 'discard', player: me, mustDiscard: 1 };
      d.players[me].hand = ['rocket-propelled-gnome', 'lost-in-the-maize', 'wild-growth'];
    });
    // lost-in-the-maize has the lowest keep value of the three.
    expect(chooseAiAction(s)).toEqual({ type: 'discardCard', player: me, cardId: 'lost-in-the-maize' });
  });

  it('rockets an enemy gnome standing in our Home Garden', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    // Clear our own gnomes first: a real game never has a friendly gnome
    // co-located with an enemy without an active fight, and that artificial
    // state distorts move scoring. The invader alone sits on our home.
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
    });
    const invader = withGnome(s, foe, s.players[me].homePos);
    s = mutate(invader.state, (d) => {
      d.players[me].hand.push('rocket-propelled-gnome');
      d.players[me].wishes = 0; // no Wishes to draw
    });
    const action = chooseAiAction(s);
    expect(action.type).toBe('playCard');
    if (action.type === 'playCard') {
      expect(action.cardId).toBe('rocket-propelled-gnome');
      expect(action.targets?.units).toEqual([invader.unitId]);
    }
  });

  it('clones one of our own gnomes with Seeing Double', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
    });
    const g = withGnome(s, me, s.players[me].homePos);
    s = mutate(g.state, (d) => {
      d.players[me].hand.push('seeing-double');
    });
    const action = chooseAiAction(s);
    expect(action.type).toBe('playCard');
    if (action.type === 'playCard') {
      expect(action.cardId).toBe('seeing-double');
      expect(action.targets?.units).toEqual([g.unitId]);
    }
  });

  it('plants a free economy garden with Wild Growth', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      d.players[me].hand.push('wild-growth');
      d.players[me].wishes = 0; // no Wishes to draw or plant normally
    });
    const action = chooseAiAction(s);
    expect(action.type).toBe('playCard');
    if (action.type === 'playCard') {
      expect(action.cardId).toBe('wild-growth');
      const gt = action.targets?.gardenType;
      expect(gt === 'mushroom' || gt === 'dandelion').toBe(true);
    }
  });

  it('draws a card when wish-rich with hand room and nothing better to do', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
      d.players[me].wishes = 5;
      d.players[me].hand = [];
    });
    expect(chooseAiAction(s)).toEqual({ type: 'drawCard', player: me });
  });
});

describe('AI respond policies', () => {
  it('Nope-Gnomes a Rocket aimed at one of our gnomes', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    const target = withGnome(s, foe, { x: 3, y: 3 });
    s = mutate(target.state, (d) => {
      d.players[me].hand.push('rocket-propelled-gnome');
      d.players[foe].hand.push('nope-gnome');
    });
    s = applyAction(s, {
      type: 'playCard',
      player: me,
      cardId: 'rocket-propelled-gnome',
      targets: { units: [target.unitId] },
    });
    expect(s.pendingDecision).toMatchObject({ kind: 'cardResponse', player: foe });
    expect(chooseAiAction(s)).toEqual({ type: 'respondPlayCard', player: foe, cardId: 'nope-gnome' });
  });

  it('shields with Gnomebody Dies in a flytrap fight', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = mutate(g.state, (d) => {
      d.gardens['3,2'] = {
        type: 'flytrap',
        plantedOnTurn: 0,
        stunnedForPlayerTurn: null,
        doubledForPlayerTurn: null,
      };
      d.players[me].hand.push('gnomebody-dies');
    });
    s = applyAction(s, { type: 'move', player: me, unitId: g.unitId, to: { x: 3, y: 2 } });
    expect(s.pendingDecision).toMatchObject({ kind: 'fightRespond', player: me });
    expect(chooseAiAction(s)).toEqual({ type: 'respondPlayCard', player: me, cardId: 'gnomebody-dies' });
  });

  it('swings the dice with 4 Leaf Clover when storming an enemy Home Garden', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    const foeHome = s.players[foe].homePos;
    const n = s.config.boardSize;
    const adj = [
      { x: foeHome.x, y: foeHome.y - 1 },
      { x: foeHome.x + 1, y: foeHome.y },
      { x: foeHome.x, y: foeHome.y + 1 },
      { x: foeHome.x - 1, y: foeHome.y },
    ].find((p) => p.x >= 0 && p.y >= 0 && p.x < n && p.y < n)!;
    const attacker = withGnome(s, me, adj);
    const defender = withGnome(attacker.state, foe, foeHome);
    s = mutate(defender.state, (d) => {
      d.players[me].hand.push('four-leaf-clover');
      d.players[foe].hand = []; // so the Respond window reaches us
    });
    s = applyAction(s, { type: 'move', player: me, unitId: attacker.unitId, to: foeHome });
    expect(s.pendingDecision).toMatchObject({ kind: 'fightRespond', player: me });
    expect(chooseAiAction(s)).toEqual({ type: 'respondPlayCard', player: me, cardId: 'four-leaf-clover' });
  });
});

// ---------------------------------------------------------------------------
// AI vs AI smoke — full games must finish without engine errors
// ---------------------------------------------------------------------------

describe('AI vs AI smoke', () => {
  const configs: Array<{ label: string; extra: Partial<Omit<CreateGameOptions, 'players'>>; count: 2 | 4 }> = [
    { label: '2p none', extra: {}, count: 2 },
    { label: '2p many', extra: { gardenPreset: 'many' }, count: 2 },
    { label: '4p few', extra: { gardenPreset: 'few' }, count: 4 },
  ];

  for (const cfg of configs) {
    for (const seed of [1, 2, 3]) {
      it(`finishes a full game (${cfg.label}, seed ${seed})`, () => {
        let s = newGame(seed, cfg.extra, cfg.count);
        let actions = 0;
        const cap = 5000;
        while (!isGameOver(s) && actions < cap) {
          s = applyAction(s, chooseAiAction(s));
          actions += 1;
          if (actions % 100 === 0) checkInvariants(s);
        }
        expect(isGameOver(s)).toBe(true);
        checkInvariants(s);
        expect(s.events.at(-1)?.type).toBe('gameFinished');
        if (s.winner !== null) {
          expect(s.winner).toBeGreaterThanOrEqual(0);
          expect(s.winner).toBeLessThan(cfg.count);
        }
      });
    }
  }
});
