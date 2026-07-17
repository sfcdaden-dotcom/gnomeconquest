/**
 * Shared test helpers (imported by *.test.ts only — not part of the engine).
 *
 * Because GameState is plain JSON-serializable data (an engine contract),
 * tests may hand-craft scenarios by cloning a state and mutating the clone —
 * the engine never trusts prior state shape beyond its documented invariants.
 */

import { expect } from 'vitest';
import type { CreateGameOptions, GameState, Garden, GardenType, PlayerId, Pos } from './index';
import { applyAction, chooseAiAction, createGame, isGameOver, posKey } from './index';

export function newGame(
  seed = 42,
  extra: Partial<Omit<CreateGameOptions, 'players'>> = {},
  count: 2 | 4 = 2,
): GameState {
  const players = Array.from({ length: count }, (_, i) => ({
    name: `P${i}`,
    controller: 'cpu' as const,
  }));
  return createGame({ players, ...extra }, seed);
}

/** Drive the game with the AI until `stop(state)`, game over, or maxActions. */
export function drive(
  state: GameState,
  stop: (s: GameState) => boolean,
  maxActions = 2000,
): GameState {
  let s = state;
  for (let i = 0; i < maxActions; i++) {
    if (isGameOver(s) || stop(s)) return s;
    s = applyAction(s, chooseAiAction(s));
  }
  return s;
}

/** Roll off + first harvest, until the first Action Phase awaits input. */
export function toActionPhase(
  seed: number,
  extra: Partial<Omit<CreateGameOptions, 'players'>> = {},
  count: 2 | 4 = 2,
): GameState {
  const s = drive(
    newGame(seed, extra, count),
    (x) => x.status === 'playing' && !x.pendingDecision && x.turn?.phase === 'action',
  );
  expect(s.turn?.phase).toBe('action');
  return s;
}

/** Clone the state and apply test-scenario mutations. */
export function mutate(state: GameState, fn: (draft: GameState) => void): GameState {
  const s = structuredClone(state);
  fn(s);
  return s;
}

/** Drop an extra gnome for `player` at `pos` (books it as spawned). */
export function withGnome(
  state: GameState,
  player: PlayerId,
  pos: Pos,
): { state: GameState; unitId: string } {
  let unitId = '';
  const s = mutate(state, (d) => {
    unitId = `u${d.nextUnitId++}`;
    d.units[unitId] = { id: unitId, owner: player, kind: 'gnome', pos: { ...pos }, movedOnTurn: null };
    d.players[player].gnomesSpawned += 1;
  });
  return { state: s, unitId };
}

/** Place a garden at `pos` (default: pre-game planting, i.e. already Active). */
export function withGarden(
  state: GameState,
  pos: Pos,
  type: Exclude<GardenType, 'home'>,
  plantedOnTurn = 0,
): GameState {
  return mutate(state, (d) => {
    const g: Garden = { type, plantedOnTurn, stunnedForPlayerTurn: null, doubledForPlayerTurn: null };
    d.gardens[posKey(pos)] = g;
  });
}

/** Put cards straight into a player's hand. */
export function withHand(state: GameState, player: PlayerId, ...cards: string[]): GameState {
  return mutate(state, (d) => {
    d.players[player].hand.push(...cards);
  });
}

export function activePlayer(s: GameState): PlayerId {
  const t = s.turn;
  if (!t) throw new Error('no active turn');
  return t.activePlayer;
}

export function totalGnomes(s: GameState): number {
  return Object.values(s.units).filter((u) => u.kind === 'gnome').length;
}
