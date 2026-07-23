/**
 * The settle loop: after each dispatched action the engine auto-advances
 * everything that needs no human input (empty Respond windows, dice rolls,
 * single-option harvests, queued fights, eliminations, forced turn ends) and
 * stops when it either needs a decision (`state.pendingDecision`) or is idle
 * in the active player's Action Phase.
 *
 * Every branch below is required to make progress (pop a stack entry, resolve
 * a fight round, drain a queue, advance a phase), so the loop terminates. The
 * guard is a bug net, not a rules mechanism: hitting it means an engine
 * invariant broke, and the thrown error carries enough state to say where.
 */

import type { GameState } from './types';
import { internal, requireTurn } from './helpers';
import { progressFight, startNextQueuedFight } from './fights';
import { continueHarvest } from './gardens';
import { progressCardStack } from './cards';
import { processNextElimination } from './elimination';
import { endTurnInternal } from './turns';

/**
 * Maximum auto-advance transitions per action.
 *
 * Measured: across 48 complete AI-vs-AI games (Easy/Normal/Hard × 8 seeds ×
 * 2- and 4-player), the deepest single settle was **6** transitions. 1,000
 * therefore leaves >150× headroom over observed worst-case play while still
 * failing fast instead of hanging the UI thread — the previous bound of
 * 100,000 could spin for seconds before reporting. See settle.test.ts, which
 * asserts both the headroom and the diagnostic thrown on overrun.
 */
export const MAX_SETTLE_STEPS = 1000;

export function settle(draft: GameState): void {
  for (let step = 0; step < MAX_SETTLE_STEPS; step++) {
    if (draft.status === 'finished') {
      draft.pendingDecision = null;
      return;
    }
    if (draft.pendingDecision) return;
    // The card stack outranks everything: a card played inside a fight's
    // Respond window (or any other interrupt) must fully resolve — including
    // its own response windows — before the interrupted thing continues.
    if (draft.cardStack.length > 0) {
      progressCardStack(draft);
      continue;
    }
    if (draft.fight) {
      progressFight(draft);
      continue;
    }
    if (draft.eliminationQueue.length > 0) {
      processNextElimination(draft);
      continue;
    }
    if (draft.fightQueue.length > 0) {
      startNextQueuedFight(draft);
      continue;
    }
    if (draft.status === 'rolloff') return; // rollOff decision is always pending here
    if (draft.turnMustEnd) {
      endTurnInternal(draft);
      continue;
    }
    const t = requireTurn(draft);
    if (t.phase === 'harvest') {
      continueHarvest(draft);
      continue;
    }
    return; // Action Phase, waiting for the active player
  }
  internal(`settle loop did not converge (engine bug) — ${describeSettleState(draft, MAX_SETTLE_STEPS)}`);
}

/**
 * One-line snapshot of everything that decides which settle branch runs, so a
 * non-convergence report says which branch is spinning rather than just "bug".
 */
export function describeSettleState(state: GameState, steps: number): string {
  const parts = [
    `steps=${steps}`,
    `status=${state.status}`,
    `phase=${state.turn?.phase ?? 'none'}`,
    `currentPlayer=${state.turn?.activePlayer ?? 'none'}`,
    `pendingDecision=${state.pendingDecision ? state.pendingDecision.kind : 'none'}`,
    `pendingPlayer=${state.pendingDecision ? state.pendingDecision.player : 'none'}`,
    `fight=${state.fight ? `active(id=${state.fight.id},round=${state.fight.round})` : 'none'}`,
    `fightQueue=${state.fightQueue.length}`,
    `cardStack=${state.cardStack.length}`,
    `responseQueue=${state.responseQueue.length}`,
    `eliminationQueue=${state.eliminationQueue.length}`,
    `harvestRemaining=${state.harvest ? state.harvest.remaining.length : 'none'}`,
    `harvestMoveQueue=${state.harvest ? state.harvest.moveQueue.length : 'none'}`,
    `turnMustEnd=${state.turnMustEnd}`,
    `turn=${state.turn?.number ?? 'none'}`,
  ];
  return parts.join(' ');
}
