/**
 * New-game setup: player count, per-seat name + human/CPU, board preset,
 * Center Star toggle, optional seed.
 */

import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AiDifficulty, CreateGameOptions, GardenPreset, GardenPresetDef, PlayerController } from '../engine';
import { GARDEN_PRESETS, DEFAULT_GARDEN_PRESET_ID } from '../engine';
import { playerColor, randomSeed, PLAYER_COLOR_NAMES } from './meta';
import { PresetEditor } from './PresetEditor';
import { CUSTOM_EDITOR_BOARD_SIZE, downloadCustomPreset, parseCustomPresetFile } from './customPresets';

export interface SetupResult {
  options: CreateGameOptions;
  seed: number;
}

interface SeatDraft {
  name: string;
  controller: PlayerController;
  difficulty: AiDifficulty;
}

const DEFAULT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave'];
const DIFFICULTIES: readonly AiDifficulty[] = ['easy', 'normal', 'hard'];
const DIFFICULTY_LABELS: Record<AiDifficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

function isCustomPresetId(id: string): boolean {
  return id.startsWith('custom:');
}

export function SetupScreen({ onStart }: { onStart: (r: SetupResult) => void }) {
  const [count, setCount] = useState<2 | 4>(2);
  const [seats, setSeats] = useState<SeatDraft[]>([
    { name: DEFAULT_NAMES[0], controller: 'human', difficulty: 'normal' },
    { name: DEFAULT_NAMES[1], controller: 'cpu', difficulty: 'normal' },
    { name: DEFAULT_NAMES[2], controller: 'cpu', difficulty: 'normal' },
    { name: DEFAULT_NAMES[3], controller: 'cpu', difficulty: 'normal' },
  ]);
  const [preset, setPreset] = useState<GardenPreset>('few');
  const [customPresets, setCustomPresets] = useState<GardenPresetDef[]>([]);
  const [editing, setEditing] = useState(false);
  const [centerStar, setCenterStar] = useState(true);
  const [seedText, setSeedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const allPresets = [...GARDEN_PRESETS, ...customPresets];
  const presetDef = allPresets.find((p) => p.id === preset) ?? allPresets.find((p) => p.id === DEFAULT_GARDEN_PRESET_ID)!;
  const editingExisting = isCustomPresetId(preset) ? customPresets.find((p) => p.id === preset) : undefined;

  function updateSeat(i: number, patch: Partial<SeatDraft>) {
    setSeats((s) => s.map((seat, j) => (j === i ? { ...seat, ...patch } : seat)));
  }

  function addOrUpdateCustomPreset(def: GardenPresetDef) {
    setCustomPresets((list) => {
      const idx = list.findIndex((p) => p.id === def.id);
      if (idx === -1) return [...list, def];
      const next = [...list];
      next[idx] = def;
      return next;
    });
    setPreset(def.id);
    setEditing(false);
  }

  function removeCustomPreset(id: string) {
    setCustomPresets((list) => list.filter((p) => p.id !== id));
    setPreset('few');
  }

  function importPresetFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const def = parseCustomPresetFile(String(reader.result));
        setCustomPresets((list) => [...list, def]);
        setPreset(def.id);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read that preset file.');
      }
    };
    reader.readAsText(file);
  }

  function start() {
    const parsed = seedText.trim() === '' ? randomSeed() : Number(seedText.trim());
    if (!Number.isFinite(parsed)) {
      setError('Seed must be a number (or leave it blank for a random one).');
      return;
    }
    const isCustom = isCustomPresetId(preset);
    // Custom presets always carry 4 homes (seat order west/north/east/south);
    // 2-player games use the opposite pair (indices 0 and 2), matching how
    // the engine's own default layout picks seats for 2 vs 4 players.
    const customHomes = presetDef.homes && (count === 2 ? [presetDef.homes[0], presetDef.homes[2]] : presetDef.homes);
    const options: CreateGameOptions = {
      gardenPreset: preset,
      ...(isCustom
        ? {
            boardSize: CUSTOM_EDITOR_BOARD_SIZE,
            customGardens: presetDef.build(CUSTOM_EDITOR_BOARD_SIZE),
            ...(customHomes ? { customHomes } : {}),
          }
        : {}),
      centerStar,
      players: seats.slice(0, count).map((s, i) => ({
        name: s.name.trim() || DEFAULT_NAMES[i],
        controller: s.controller,
        ...(s.controller === 'cpu' ? { difficulty: s.difficulty } : {}),
      })),
    };
    onStart({ options, seed: Math.floor(parsed) });
  }

  if (editing) {
    return (
      <PresetEditor initial={editingExisting} onCancel={() => setEditing(false)} onSave={addOrUpdateCustomPreset} />
    );
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
              {seat.controller === 'cpu' && (
                <select
                  className="preset-select small"
                  value={seat.difficulty}
                  aria-label={`Seat ${i + 1} CPU difficulty`}
                  onChange={(e) => updateSeat(i, { difficulty: e.target.value as AiDifficulty })}
                >
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {DIFFICULTY_LABELS[d]}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>

        <div className="setup-row">
          <span className="setup-label">Extra gardens</span>
          <select
            className="preset-select"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            aria-label="Extra-garden preset"
          >
            <optgroup label="Built-in">
              {GARDEN_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            {customPresets.length > 0 && (
              <optgroup label="Custom (this session)">
                {customPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <p className="preset-description muted small">{presetDef.description}</p>
        <div className="btn-row">
          <button type="button" className="btn small" onClick={() => setEditing(true)}>
            🎨 {editingExisting ? 'Edit this preset' : 'New preset'}
          </button>
          <button type="button" className="btn small" onClick={() => importInputRef.current?.click()}>
            📂 Import preset…
          </button>
          {editingExisting && (
            <>
              <button type="button" className="btn small" onClick={() => downloadCustomPreset(editingExisting, CUSTOM_EDITOR_BOARD_SIZE)}>
                💾 Export
              </button>
              <button type="button" className="btn small warn" onClick={() => removeCustomPreset(editingExisting.id)}>
                🗑️ Remove
              </button>
            </>
          )}
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            aria-label="Import a garden preset file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importPresetFile(file);
              e.target.value = '';
            }}
          />
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
