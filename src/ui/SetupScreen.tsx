/**
 * New-game setup: player count, per-seat name + human/CPU, board preset,
 * Center Star toggle, optional seed.
 */

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { CreateGameOptions, GardenPreset, PlayerController } from '../engine';
import { playerColor, randomSeed, PLAYER_COLOR_NAMES } from './meta';

export interface SetupResult {
  options: CreateGameOptions;
  seed: number;
}

interface SeatDraft {
  name: string;
  controller: PlayerController;
}

const DEFAULT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave'];

export function SetupScreen({ onStart }: { onStart: (r: SetupResult) => void }) {
  const [count, setCount] = useState<2 | 4>(2);
  const [seats, setSeats] = useState<SeatDraft[]>([
    { name: DEFAULT_NAMES[0], controller: 'human' },
    { name: DEFAULT_NAMES[1], controller: 'cpu' },
    { name: DEFAULT_NAMES[2], controller: 'cpu' },
    { name: DEFAULT_NAMES[3], controller: 'cpu' },
  ]);
  const [preset, setPreset] = useState<GardenPreset>('few');
  const [centerStar, setCenterStar] = useState(true);
  const [seedText, setSeedText] = useState('');
  const [error, setError] = useState<string | null>(null);

  function updateSeat(i: number, patch: Partial<SeatDraft>) {
    setSeats((s) => s.map((seat, j) => (j === i ? { ...seat, ...patch } : seat)));
  }

  function start() {
    const parsed = seedText.trim() === '' ? randomSeed() : Number(seedText.trim());
    if (!Number.isFinite(parsed)) {
      setError('Seed must be a number (or leave it blank for a random one).');
      return;
    }
    const options: CreateGameOptions = {
      gardenPreset: preset,
      centerStar,
      players: seats.slice(0, count).map((s, i) => ({
        name: s.name.trim() || DEFAULT_NAMES[i],
        controller: s.controller,
      })),
    };
    onStart({ options, seed: Math.floor(parsed) });
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1 className="game-title">🧙 Whimsy Wars 🌼</h1>
        <p className="tagline">Harvest gardens, hoard wishes, and gnome your enemies into the compost.</p>

        <div className="setup-row">
          <span className="setup-label">Players</span>
          <div className="btn-row">
            {([2, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                className={`btn${count === n ? ' accent' : ''}`}
                onClick={() => setCount(n)}
              >
                {n} players
              </button>
            ))}
          </div>
        </div>

        <div className="seat-list">
          {seats.slice(0, count).map((seat, i) => (
            <div key={i} className="seat-row" style={{ '--pc': playerColor(i) } as CSSProperties}>
              <span className="pp-dot" title={PLAYER_COLOR_NAMES[i]} />
              <input
                type="text"
                value={seat.name}
                maxLength={16}
                aria-label={`Seat ${i + 1} name`}
                onChange={(e) => updateSeat(i, { name: e.target.value })}
              />
              <div className="btn-row">
                <button
                  type="button"
                  className={`btn small${seat.controller === 'human' ? ' accent' : ''}`}
                  onClick={() => updateSeat(i, { controller: 'human' })}
                >
                  🧑 Human
                </button>
                <button
                  type="button"
                  className={`btn small${seat.controller === 'cpu' ? ' accent' : ''}`}
                  onClick={() => updateSeat(i, { controller: 'cpu' })}
                >
                  🤖 CPU
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="setup-row">
          <span className="setup-label">Extra gardens</span>
          <div className="btn-row">
            {(['none', 'few', 'many'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`btn${preset === p ? ' accent' : ''}`}
                onClick={() => setPreset(p)}
              >
                {p === 'none' ? 'None' : p === 'few' ? 'Few (tunnels)' : 'Many'}
              </button>
            ))}
          </div>
        </div>

        <div className="setup-row">
          <span className="setup-label">Center Star ⭐</span>
          <label className="check-label">
            <input type="checkbox" checked={centerStar} onChange={(e) => setCenterStar(e.target.checked)} />
            Occupying the center raises your wish cap to 6
          </label>
        </div>

        <div className="setup-row">
          <span className="setup-label">Seed</span>
          <input
            type="text"
            className="seed-input"
            placeholder="random"
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            aria-label="Random seed (optional)"
          />
        </div>

        {error && <div className="setup-error">{error}</div>}

        <button type="button" className="btn accent big" onClick={start}>
          🌱 Start the war
        </button>
      </div>
    </div>
  );
}
