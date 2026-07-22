/**
 * Core engine: reducer-style API.
 *
 *   applyAction(state, action) → new GameState   (pure; input never mutated;
 *                                                 illegal actions throw EngineError)
 *   getLegalActions(state[, player]) → Action[]  (complete, executable actions
 *                                                 for the player who must act)
 *   getPlayerToAct(state) → PlayerId | null
 *
 * After applying the requested action, the engine "settles": it auto-advances
 * everything that needs no human input and stops when it either needs a
 * decision (`state.pendingDecision`) or is idle in the active player's Action
 * Phase.
 *
 * This file is the façade. The implementation is split by responsibility:
 *
 *   actions.ts       action dispatch + the Action-Phase handlers
 *   turns.ts         roll-off, turn start/end, movement legality
 *   settle.ts        the auto-advance loop and its convergence diagnostics
 *   elimination.ts   eliminations, snailify, win detection
 *   legalActions.ts  legal-action enumeration and card-target expansion
 *   gardens.ts       harvests, planting, entry effects
 *   fights.ts        fight resolution
 *   cards.ts         the card framework and the card stack
 */

import type { Action, GameState, PlayerId } from './types';
import { gnomesOnBoard, illegal } from './helpers';
import { dispatch } from './actions';
import { settle } from './settle';

// Re-exported so `./engine` stays the single import site for the core API.
export { getPlayerToAct } from './turns';
export { getLegalActions, getLegalActionIntents, getTargetOptions } from './legalActions';

/**
 * Events kept on the state (rolling window). Bounds the per-action clone cost
 * so thousands-of-actions simulations stay O(actions), not O(actions²).
 */
const MAX_EVENTS = 1000;

export function isGameOver(state: GameState): boolean {
  return state.status === 'finished';
}

/**
 * Validate and apply one action, returning a NEW state (the input is never
 * mutated). Illegal or malformed actions throw EngineError with a clear
 * message and leave the input state untouched.
 */
export function applyAction(state: GameState, action: Action): GameState {
  if (state.status === 'finished') {
    illegal(`The game is over (winner: ${state.winner === null ? 'none' : state.winner})`);
  }
  const draft = structuredClone(state) as GameState;
  dispatch(draft, action);
  settle(draft);
  if (draft.events.length > MAX_EVENTS) {
    draft.events.splice(0, draft.events.length - MAX_EVENTS);
  }
  return draft;
}

/** Convenience: number of gnomes `player` currently has on the board. */
export function boardGnomes(state: GameState, player: PlayerId): number {
  return gnomesOnBoard(state, player);
}
