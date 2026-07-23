/**
 * Self-play match recorder tests.
 *
 * The load-bearing property is FAITHFULNESS: a MatchRecord is a complete
 * description of its game, so replaying it must reproduce the exact outcome.
 * The rest pin the recorded metadata (seed, config, winner + controller) and
 * the dataset (de)serialization.
 */

import { describe, expect, it } from 'vitest';
import type { CreateGameOptions } from './index';
import {
  MATCH_RECORD_SCHEMA,
  fromNdjson,
  isGameOver,
  playSelfPlayGame,
  replayMatch,
  simulateSelfPlay,
  toNdjson,
} from './index';

const TWO_HARD: CreateGameOptions = {
  players: [
    { name: 'North', controller: 'cpu', difficulty: 'hard' },
    { name: 'South', controller: 'cpu', difficulty: 'hard' },
  ],
};

describe('self-play recorder', () => {
  it('records a finished game: seed, config, a non-empty action list and a winner', () => {
    const rec = playSelfPlayGame(TWO_HARD, 1);
    expect(rec.schemaVersion).toBe(MATCH_RECORD_SCHEMA);
    expect(rec.seed).toBe(1);
    expect(rec.config.players.map((p) => p.name)).toEqual(['North', 'South']);
    expect(rec.config.players.every((p) => p.difficulty === 'hard')).toBe(true);
    expect(rec.actions.length).toBeGreaterThan(0);
    expect(rec.result.reason).toBe('lastStanding');
    expect(rec.result.actionCount).toBe(rec.actions.length);
    expect(rec.result.turns).toBeGreaterThan(0);
  });

  it('derives the winner name and controller from the winning seat', () => {
    const rec = playSelfPlayGame(TWO_HARD, 2);
    expect(rec.result.winner).not.toBeNull();
    const seat = rec.result.winner!;
    expect(rec.result.winnerName).toBe(rec.config.players[seat].name);
    expect(rec.result.winnerController).toBe('cpu');
  });

  it('is deterministic: same (options, seed) yields an identical record', () => {
    const a = playSelfPlayGame(TWO_HARD, 7);
    const b = playSelfPlayGame(TWO_HARD, 7);
    expect(b).toEqual(a);
  });

  it('is faithful: replaying the record reproduces the exact final outcome', () => {
    const rec = playSelfPlayGame(TWO_HARD, 3);
    const final = replayMatch(rec);
    expect(isGameOver(final)).toBe(true);
    expect(final.winner).toBe(rec.result.winner);
    expect(final.status).toBe('finished');
    // The last emitted event is always the game-over marker.
    expect(final.events.at(-1)?.type).toBe('gameFinished');
  });

  it('captures the WHOLE game — the action list is never capped or trimmed', () => {
    // A 4-player game runs well past the 1000-event UI window and the ~250 the
    // old metrics measured, yet every action is present (replay reaches the
    // end, and the count is internally consistent).
    const rec = playSelfPlayGame(
      {
        players: [
          { name: 'P0', controller: 'cpu', difficulty: 'hard' },
          { name: 'P1', controller: 'cpu', difficulty: 'hard' },
          { name: 'P2', controller: 'cpu', difficulty: 'hard' },
          { name: 'P3', controller: 'cpu', difficulty: 'hard' },
        ],
        gardenPreset: 'few',
      },
      1,
    );
    expect(rec.result.reason).toBe('lastStanding');
    expect(rec.actions.length).toBe(rec.result.actionCount);
    expect(isGameOver(replayMatch(rec))).toBe(true);
  });

  it('marks a game that hits the runaway guard as unfinished (no truncation of real games)', () => {
    const rec = playSelfPlayGame(TWO_HARD, 1, { maxActions: 5 });
    expect(rec.actions.length).toBe(5);
    expect(rec.result.reason).toBe('unfinished');
    expect(rec.result.winner).toBeNull();
    // The prefix is still a valid, replayable game state.
    expect(() => replayMatch(rec)).not.toThrow();
  });

  it('simulateSelfPlay generates one finished record per seed', () => {
    const recs = simulateSelfPlay(TWO_HARD, 3);
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.seed)).toEqual([1, 2, 3]);
    expect(recs.every((r) => r.result.reason === 'lastStanding')).toBe(true);
  });

  it('round-trips a batch through NDJSON', () => {
    const recs = simulateSelfPlay(TWO_HARD, [10, 20]);
    const text = toNdjson(recs);
    expect(text.split('\n')).toHaveLength(2); // one record per line
    expect(fromNdjson(text)).toEqual(recs);
    expect(fromNdjson(`${text}\n\n`)).toEqual(recs); // blank lines ignored
  });
});
