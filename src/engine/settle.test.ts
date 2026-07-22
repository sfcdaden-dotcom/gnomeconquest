/**
 * Settle-loop convergence: the bound and the diagnostic.
 *
 * The loop auto-advances everything that needs no input after an action. Every
 * branch must make progress; if one ever stops doing so the engine has to fail
 * fast with enough context to identify the branch, rather than spin.
 *
 * To exercise that path deliberately, the harvest branch is replaced with a
 * no-op — a simulated engine bug that can never drain the Harvest Phase.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./gardens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gardens')>();
  return { ...actual, continueHarvest: vi.fn(actual.continueHarvest) };
});

import type { GameState } from './index';
import { applyAction, chooseAiAction, createGame, isGameOver } from './index';
import { MAX_SETTLE_STEPS, describeSettleState } from './settle';
import { continueHarvest } from './gardens';

const harvestMock = vi.mocked(continueHarvest);
const realContinueHarvest = (await vi.importActual<typeof import('./gardens')>('./gardens'))
  .continueHarvest;

/** Stall the harvest branch: it returns without ever advancing the phase. */
function breakHarvestBranch(): void {
  harvestMock.mockImplementation(() => {});
}

// Put the real implementation back explicitly, so a later test in this file
// runs against the genuine engine rather than a silently emptied mock.
afterEach(() => {
  harvestMock.mockImplementation(realContinueHarvest);
});

function twoPlayerGame(seed = 5): GameState {
  return createGame(
    {
      players: [
        { name: 'A', controller: 'cpu' },
        { name: 'B', controller: 'cpu' },
      ],
    },
    seed,
  );
}

/** Answer the roll-off; the final answer starts turn 1 in the Harvest Phase. */
function rollOff(s: GameState): GameState {
  let cur = s;
  for (let i = 0; i < 20 && cur.status === 'rolloff'; i++) {
    cur = applyAction(cur, chooseAiAction(cur));
  }
  return cur;
}

describe('settle loop bound', () => {
  it('is a practical bound, not an effectively-infinite one', () => {
    expect(MAX_SETTLE_STEPS).toBe(1000);
  });

  it('fails with a useful diagnostic instead of hanging when a branch stalls', () => {
    breakHarvestBranch();

    let message = '';
    expect(() => {
      try {
        rollOff(twoPlayerGame());
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }).toThrow(/settle loop did not converge/);

    // The diagnostic must say WHERE it was stuck, not just that it was.
    expect(message).toContain(`steps=${MAX_SETTLE_STEPS}`);
    expect(message).toContain('status=playing');
    expect(message).toContain('phase=harvest'); // the stalled branch
    expect(message).toContain('pendingDecision=none');
    expect(message).toContain('fight=none');
    expect(message).toContain('cardStack=0');
    expect(message).toMatch(/currentPlayer=[01]/);
    expect(message).toMatch(/turn=1\b/);
  });

  it('reports every field a stall could be blamed on', () => {
    const text = describeSettleState(twoPlayerGame(9), 7);
    for (const field of [
      'steps',
      'status',
      'phase',
      'currentPlayer',
      'pendingDecision',
      'pendingPlayer',
      'fight',
      'fightQueue',
      'cardStack',
      'responseQueue',
      'eliminationQueue',
      'harvestRemaining',
      'harvestMoveQueue',
      'turnMustEnd',
      'turn',
    ]) {
      expect(text, `diagnostic should report ${field}`).toContain(`${field}=`);
    }
  });

  it('a full AI game never trips the reduced bound', () => {
    // The evidence for lowering the guard from 100,000: real play settles in
    // single-digit steps, so 1,000 cannot be reached by legitimate play.
    let s = twoPlayerGame(77);
    for (let i = 0; i < 3000 && !isGameOver(s); i++) {
      s = applyAction(s, chooseAiAction(s));
    }
    expect(isGameOver(s)).toBe(true);
  }, 120_000);
});
