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
  withGarden,
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

  it('plants Maize near home once Dandelion/Mushroom are unavailable (garden variety)', () => {
    let s = toActionPhase(1);
    const me = activePlayer(s);
    const home = s.players[me].homePos;
    const pos = { x: home.x + 1, y: home.y };
    const g = withGnome(s, me, pos);
    s = mutate(g.state, (d) => {
      d.supply.dandelion = 0;
      d.supply.mushroom = 0;
      d.players[me].wishes = 5;
      d.units[g.unitId].movedOnTurn = d.turn!.number; // no move competes with the plant
    });
    expect(chooseAiAction(s)).toEqual({ type: 'plant', player: me, pos, gardenType: 'maize' });
  });

  it('plants a Tunnel only once one already exists on the board (garden variety)', () => {
    let s = toActionPhase(1);
    const me = activePlayer(s);
    const home = s.players[me].homePos;
    const pos = { x: home.x + 1, y: home.y };
    const g = withGnome(s, me, pos);
    s = mutate(g.state, (d) => {
      const blank = { plantedOnTurn: 0, stunnedForPlayerTurn: null, doubledForPlayerTurn: null };
      d.gardens['0,0'] = { type: 'tunnel', ...blank }; // an existing tunnel elsewhere to link to
      d.supply.dandelion = 0;
      d.supply.mushroom = 0;
      d.supply.maize = 0;
      d.supply.flytrap = 0;
      d.players[me].wishes = 5;
      d.units[g.unitId].movedOnTurn = d.turn!.number;
    });
    expect(chooseAiAction(s)).toEqual({ type: 'plant', player: me, pos, gardenType: 'tunnel' });
  });

  it('spreads out instead of balling a gnome onto an already-stacked square', () => {
    // The only square that advances toward the foe home is deliberately stacked
    // with three friendly gnomes. A 4th onto it is penalized below even ending
    // the turn, so the AI declines to pile on (before anti-balling it advanced
    // there every time — the "move them all together" behaviour).
    let s = toActionPhase(3);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    const foeHome = s.players[foe].homePos;
    const myHome = s.players[me].homePos;
    const dir = Math.sign(foeHome.x - myHome.x) || 1; // homes sit on the same row
    const mover = { x: foeHome.x - 3 * dir, y: foeHome.y };
    const stacked = { x: foeHome.x - 2 * dir, y: foeHome.y }; // the one advancing step
    // Rebuild the actor's force: one fresh mover + three spent gnomes stacked
    // on the single advancing square. Clear gardens around so nothing else skews
    // the move scores.
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
      for (const key of Object.keys(d.gardens)) {
        const [x, y] = key.split(',').map(Number);
        if (d.gardens[key].type !== 'home' && Math.abs(x - mover.x) + Math.abs(y - mover.y) <= 2) {
          delete d.gardens[key];
        }
      }
      d.players[me].wishes = 1; // < 2 disables planting, < 4 disables drawing
      d.players[me].hand = [];
    });
    const m = withGnome(s, me, mover);
    const g1 = withGnome(m.state, me, stacked);
    const g2 = withGnome(g1.state, me, stacked);
    const g3 = withGnome(g2.state, me, stacked);
    s = mutate(g3.state, (d) => {
      const t = d.turn!.number;
      for (const id of [g1.unitId, g2.unitId, g3.unitId]) d.units[id].movedOnTurn = t; // spent
      d.units[m.unitId].movedOnTurn = null; // fresh mover
    });
    expect(chooseAiAction(s)).toEqual({ type: 'endTurn', player: me });
  });

  it('does not plant an economy garden far from home (no abandoned-garden trail)', () => {
    let s = toActionPhase(3);
    const me = activePlayer(s);
    const home = s.players[me].homePos;
    const far = { x: home.x === 0 ? 4 : home.x - 4 < 0 ? home.x + 4 : home.x - 4, y: home.y === 3 ? 6 : 3 };
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
      delete d.gardens[`${far.x},${far.y}`];
      d.players[me].wishes = 5; // plenty to plant with
      d.players[me].hand = [];
    });
    const g = withGnome(s, me, far);
    s = g.state;
    // manhattan(far, home) must exceed the cluster radius for this to be meaningful.
    expect(Math.abs(far.x - home.x) + Math.abs(far.y - home.y)).toBeGreaterThan(3);
    expect(chooseAiAction(s).type).not.toBe('plant');
  });

  it('plants an economy garden near home to seed the cluster', () => {
    let s = toActionPhase(3);
    const me = activePlayer(s);
    const home = s.players[me].homePos;
    const pos = { x: home.x, y: home.y === 0 ? 1 : home.y - 1 < 0 ? home.y + 1 : home.y - 1 };
    const g = withGnome(s, me, pos);
    s = mutate(g.state, (d) => {
      // Clear any preset economy gardens near home so the cluster starts empty.
      for (const key of Object.keys(d.gardens)) {
        const gd = d.gardens[key];
        if (gd.type !== 'dandelion' && gd.type !== 'mushroom') continue;
        const [x, y] = key.split(',').map(Number);
        if (Math.abs(x - home.x) + Math.abs(y - home.y) <= 3) delete d.gardens[key];
      }
      delete d.gardens[`${pos.x},${pos.y}`];
      d.supply.mushroom = 0; // force the dandelion branch for a stable assertion
      d.players[me].wishes = 5;
      d.players[me].hand = [];
      d.units[g.unitId].movedOnTurn = d.turn!.number; // no move competes with the plant
    });
    expect(chooseAiAction(s)).toEqual({ type: 'plant', player: me, pos, gardenType: 'dandelion' });
  });

  it('Hard: plants a Maize deterrent on the enemy attack lane, not near its own home', () => {
    let s = toActionPhase(3);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    const foeHome = s.players[foe].homePos;
    const myHome = s.players[me].homePos;
    const dir = Math.sign(foeHome.x - myHome.x) || 1;
    const porch = { x: foeHome.x - dir, y: foeHome.y }; // on the foe's porch, facing us
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
      delete d.gardens[`${porch.x},${porch.y}`];
      d.players[me].difficulty = 'hard';
      d.players[me].wishes = 5;
      d.players[me].hand = [];
    });
    const g = withGnome(s, me, porch);
    s = mutate(g.state, (d) => {
      d.units[g.unitId].movedOnTurn = d.turn!.number; // already moved: only the plant competes
    });
    expect(chooseAiAction(s)).toEqual({ type: 'plant', player: me, pos: porch, gardenType: 'maize' });
  });

  it('Hard refuses to wall its own base where Normal would plant a maize guard', () => {
    let s = toActionPhase(3);
    const me = activePlayer(s);
    const home = s.players[me].homePos;
    const pos = { x: home.x, y: home.y === 0 ? 1 : home.y - 1 < 0 ? home.y + 1 : home.y - 1 }; // adjacent to home
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
      delete d.gardens[`${pos.x},${pos.y}`];
      d.supply.dandelion = 0; // take the economy plant off the table
      d.supply.mushroom = 0;
      d.supply.tunnel = 0;
      d.players[me].wishes = 3; // enough to plant, too few to make drawing worthwhile
      d.players[me].hand = [];
    });
    const g = withGnome(s, me, pos);
    s = mutate(g.state, (d) => {
      d.units[g.unitId].movedOnTurn = d.turn!.number;
    });
    // Normal plants the near-home maize guard...
    const normal = mutate(s, (d) => {
      d.players[me].difficulty = 'normal';
    });
    expect(chooseAiAction(normal)).toEqual({ type: 'plant', player: me, pos, gardenType: 'maize' });
    // ...but Hard won't hem itself in there (no enemy lane nearby), so it passes.
    const hard = mutate(s, (d) => {
      d.players[me].difficulty = 'hard';
    });
    expect(chooseAiAction(hard)).toEqual({ type: 'endTurn', player: me });
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

  it('Hard: marries two of the same opponent\'s gnomes with Gnomio & Juliet', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
    });
    const g1 = withGnome(s, foe, { x: 1, y: 1 });
    const g2 = withGnome(g1.state, foe, { x: 5, y: 5 });
    s = mutate(g2.state, (d) => {
      d.players[me].hand.push('gnomio-and-juliet');
      d.players[me].difficulty = 'hard';
      d.players[me].wishes = 0;
    });
    expect(chooseAiAction(s)).toEqual({
      type: 'playCard',
      player: me,
      cardId: 'gnomio-and-juliet',
      targets: { units: [g1.unitId, g2.unitId] },
    });
  });

  it('Hard: traps an enemy gnome sitting on a Maize Garden with Lost In The Maize', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
    });
    const maizePos = { x: 1, y: 1 };
    s = withGarden(s, maizePos, 'maize');
    const invader = withGnome(s, foe, maizePos);
    s = mutate(invader.state, (d) => {
      d.players[me].hand.push('lost-in-the-maize');
      d.players[me].difficulty = 'hard';
      d.players[me].wishes = 0;
    });
    expect(chooseAiAction(s)).toEqual({ type: 'playCard', player: me, cardId: 'lost-in-the-maize' });
  });

  it('Hard: walls the non-Home garden nearest home that an enemy is approaching', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    const foe = (me + 1) % 2;
    const home = s.players[me].homePos;
    const n = s.config.boardSize;
    const c = (n - 1) / 2;
    const stepX = home.x < c ? 1 : home.x > c ? -1 : 0;
    const stepY = home.y < c ? 1 : home.y > c ? -1 : 0;
    const gardenPos = { x: home.x + 2 * stepX, y: home.y + 2 * stepY };
    const enemyPos = { x: gardenPos.x + stepX, y: gardenPos.y + stepY };
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === me) delete d.units[id];
    });
    s = withGarden(s, gardenPos, 'dandelion');
    const invader = withGnome(s, foe, enemyPos);
    s = mutate(invader.state, (d) => {
      d.players[me].hand.push('great-wall-of-whimsy');
      d.players[me].difficulty = 'hard';
      d.players[me].wishes = 0;
    });
    expect(chooseAiAction(s)).toEqual({
      type: 'playCard',
      player: me,
      cardId: 'great-wall-of-whimsy',
      targets: { spaces: [gardenPos] },
    });
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

  it('easy difficulty passes instead of shielding with Gnomebody Dies', () => {
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
      d.players[me].difficulty = 'easy';
    });
    s = applyAction(s, { type: 'move', player: me, unitId: g.unitId, to: { x: 3, y: 2 } });
    expect(s.pendingDecision).toMatchObject({ kind: 'fightRespond', player: me });
    expect(chooseAiAction(s)).toEqual({ type: 'respondPass', player: me });
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

  // Hard's fight-commitment is a genuine win-probability calculation rather
  // than Normal's flat desperation ramp (see scoreDestination) — worth its
  // own termination check so a Hard-vs-Hard game can't stall forever.
  for (const seed of [1, 2, 3]) {
    it(`finishes a full game (2p hard, seed ${seed})`, () => {
      let s = createGame(
        {
          players: [
            { name: 'P0', controller: 'cpu', difficulty: 'hard' },
            { name: 'P1', controller: 'cpu', difficulty: 'hard' },
          ],
        },
        seed,
      );
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
    });
  }
});
