/**
 * In-game garden-preset editor: paint a layout on a fixed 7×7 grid, name it,
 * and save it. "Save" both downloads a standalone .json file (the project's
 * "no localStorage" posture means presets live on disk, not in the browser)
 * and hands the finished preset back so the setup screen can use it right
 * away without re-importing.
 *
 * Home Gardens are also movable here: click one to pick it up, then click an
 * empty space to drop it. There are always exactly 4 (seat order
 * west/north/east/south by convention) — 2-player games use Home 1 & Home 3,
 * matching how the engine's default layout already picks the opposite pair.
 */

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { GardenPresetDef, PlantableGardenType, Pos } from '../engine';
import { PLANTABLE_GARDEN_TYPES, SUPPLY_PER_TYPE, posKey } from '../engine';
import { GARDEN_META } from './meta';
import {
  CUSTOM_EDITOR_BOARD_SIZE,
  PRESET_DESCRIPTION_MAX_LENGTH,
  PRESET_LABEL_MAX_LENGTH,
  buildCustomPresetDef,
  downloadCustomPreset,
  makeCustomPresetId,
  reservedHomePositions,
} from './customPresets';

type Tool = PlantableGardenType | 'erase';

export interface PresetEditorProps {
  /** Pass the currently-selected custom preset to edit it in place; omit to start blank. */
  initial?: GardenPresetDef;
  onCancel: () => void;
  onSave: (def: GardenPresetDef) => void;
}

function initialGardens(initial: PresetEditorProps['initial']): Map<string, PlantableGardenType> {
  const map = new Map<string, PlantableGardenType>();
  if (!initial) return map;
  for (const g of initial.build(CUSTOM_EDITOR_BOARD_SIZE)) map.set(posKey(g.pos), g.type);
  return map;
}

export function PresetEditor({ initial, onCancel, onSave }: PresetEditorProps) {
  const n = CUSTOM_EDITOR_BOARD_SIZE;
  const [label, setLabel] = useState(initial?.label ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [gardens, setGardens] = useState<Map<string, PlantableGardenType>>(() => initialGardens(initial));
  const [homes, setHomes] = useState<Pos[]>(() => initial?.homes ?? reservedHomePositions(n));
  const [pickedHome, setPickedHome] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>('tunnel');
  const [error, setError] = useState<string | null>(null);

  const counts: Record<PlantableGardenType, number> = {
    dandelion: 0,
    mushroom: 0,
    flytrap: 0,
    maize: 0,
    slippery: 0,
    tunnel: 0,
  };
  for (const type of gardens.values()) counts[type] += 1;

  function cellClick(pos: Pos) {
    const key = posKey(pos);
    const homeIdx = homes.findIndex((h) => posKey(h) === key);

    if (pickedHome !== null) {
      if (homeIdx === pickedHome) {
        setPickedHome(null); // clicked its own space again: cancel the pick
        return;
      }
      if (homeIdx !== -1) {
        setPickedHome(homeIdx); // switch to carrying that home instead
        return;
      }
      if (gardens.has(key)) {
        setError('Clear the garden there first, or pick a different space.');
        return;
      }
      setHomes((hs) => hs.map((h, i) => (i === pickedHome ? pos : h)));
      setPickedHome(null);
      setError(null);
      return;
    }

    if (homeIdx !== -1) {
      setPickedHome(homeIdx);
      return;
    }

    setGardens((prev) => {
      const next = new Map(prev);
      if (tool === 'erase') {
        next.delete(key);
        return next;
      }
      if (next.get(key) === tool) {
        next.delete(key); // clicking the same type again clears it
        return next;
      }
      if (counts[tool] >= SUPPLY_PER_TYPE && next.get(key) !== tool) {
        return prev; // at supply cap for this type
      }
      next.set(key, tool);
      return next;
    });
  }

  function save() {
    if (label.trim() === '') {
      setError('Give the preset a name first.');
      return;
    }
    const gardenList: Array<{ pos: Pos; type: PlantableGardenType }> = [...gardens.entries()].map(([key, type]) => {
      const [x, y] = key.split(',').map(Number);
      return { pos: { x, y }, type };
    });
    const def = buildCustomPresetDef(initial?.id ?? makeCustomPresetId(), label.trim(), description, n, gardenList, homes);
    downloadCustomPreset(def, n);
    onSave(def);
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1 className="game-title">🎨 Garden Preset Editor</h1>
        <p className="tagline">
          Paint a layout on the board, then save it as a .json file you can load back in any time.
        </p>

        <div className="setup-row">
          <span className="setup-label">Name</span>
          <input
            type="text"
            className="editor-input"
            value={label}
            maxLength={PRESET_LABEL_MAX_LENGTH}
            placeholder="e.g. Twin Rivers"
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Preset name"
          />
        </div>
        <div className="setup-row">
          <span className="setup-label">Blurb</span>
          <input
            type="text"
            className="editor-input"
            value={description}
            maxLength={PRESET_DESCRIPTION_MAX_LENGTH}
            placeholder="One line describing the layout (optional)"
            onChange={(e) => setDescription(e.target.value)}
            aria-label="Preset description"
          />
        </div>

        <div className="editor-palette" role="toolbar" aria-label="Garden type to paint">
          {PLANTABLE_GARDEN_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className={`btn small${tool === type ? ' accent' : ''}`}
              onClick={() => setTool(type)}
              disabled={counts[type] >= SUPPLY_PER_TYPE && tool !== type}
              title={GARDEN_META[type].blurb}
            >
              {GARDEN_META[type].emoji} {GARDEN_META[type].label} ({counts[type]}/{SUPPLY_PER_TYPE})
            </button>
          ))}
          <button
            type="button"
            className={`btn small${tool === 'erase' ? ' accent' : ''}`}
            onClick={() => setTool('erase')}
            title="Clear a space"
          >
            🧹 Erase
          </button>
          <button type="button" className="btn small" onClick={() => setGardens(new Map())} title="Clear all planted gardens">
            🗑️ Clear board
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setHomes(reservedHomePositions(n));
              setPickedHome(null);
            }}
            title="Put all 4 Home Gardens back at their default spaces"
          >
            ↺ Reset homes
          </button>
        </div>

        <div className="board-wrap">
          <div className="board editor-board" style={{ '--n': n } as CSSProperties} role="grid" aria-label="Preset editor board">
            {Array.from({ length: n * n }, (_, i) => {
              const pos = { x: i % n, y: Math.floor(i / n) };
              const key = posKey(pos);
              const homeIdx = homes.findIndex((h) => posKey(h) === key);
              const type = gardens.get(key);
              const classes = ['cell'];
              if (type) classes.push(`g-${type}`);
              if (homeIdx !== -1) classes.push('editor-home');
              if (pickedHome === homeIdx && homeIdx !== -1) classes.push('picked');
              const label =
                homeIdx !== -1
                  ? `Home ${homeIdx + 1}${pickedHome === homeIdx ? ' (selected — click a space to move it)' : ''}`
                  : type
                    ? GARDEN_META[type].label
                    : null;
              return (
                <button
                  key={key}
                  type="button"
                  className={classes.join(' ')}
                  onClick={() => cellClick(pos)}
                  aria-label={`Space ${key}${label ? `, ${label}` : ''}`}
                  title={label ?? `Space ${key}`}
                >
                  {homeIdx !== -1 && (
                    <>
                      <span className="garden-emoji">🏡</span>
                      <span className="home-index">{homeIdx + 1}</span>
                    </>
                  )}
                  {type && <span className="garden-emoji">{GARDEN_META[type].emoji}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <p className="preset-description muted small">
          {pickedHome !== null
            ? `Moving Home ${pickedHome + 1} — click an empty space to drop it, or click it again to cancel.`
            : 'Click a 🏡 Home Garden to move it. 2-player games use Home 1 & Home 3; 4-player games use all four.'}
        </p>

        {error && <div className="setup-error">{error}</div>}

        <div className="btn-row">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn accent" onClick={save}>
            💾 Save preset
          </button>
        </div>
      </div>
    </div>
  );
}
