/**
 * Player-authored garden presets: built in the in-game editor, kept only in
 * memory for the current session, and saved/loaded as standalone .json files
 * (never localStorage — see DEPLOYMENT.md's "no local storage" posture).
 *
 * A custom preset is shaped exactly like a `GardenPresetDef` (see
 * `engine/gardenPresets.ts`) so the setup UI can treat built-in and custom
 * presets identically; it's just never added to the built-in registry.
 */

import type { GardenPresetDef, PlantableGardenType, Pos } from '../engine';
import { PLANTABLE_GARDEN_TYPES, posKey } from '../engine';

/** Fixed board size the in-game editor designs for (matches the engine default). */
export const CUSTOM_EDITOR_BOARD_SIZE = 7;

/** The four edge-midpoint spaces reserved for Home Gardens (any seating). */
export function reservedHomePositions(boardSize: number): Pos[] {
  const c = (boardSize - 1) / 2;
  return [
    { x: 0, y: c },
    { x: c, y: 0 },
    { x: boardSize - 1, y: c },
    { x: c, y: boardSize - 1 },
  ];
}

export function isReservedHomePosition(boardSize: number, pos: Pos): boolean {
  return reservedHomePositions(boardSize).some((p) => p.x === pos.x && p.y === pos.y);
}

const CUSTOM_PRESET_FILE_KIND = 'whimsy-wars-garden-preset';
const CUSTOM_PRESET_FILE_VERSION = 1;

/** Shared with the editor's `<input maxLength>` so imported files can't carry oversized text. */
export const PRESET_LABEL_MAX_LENGTH = 40;
export const PRESET_DESCRIPTION_MAX_LENGTH = 120;

interface CustomPresetFile {
  kind: typeof CUSTOM_PRESET_FILE_KIND;
  version: number;
  label: string;
  description: string;
  boardSize: number;
  gardens: Array<{ pos: Pos; type: PlantableGardenType }>;
}

export function makeCustomPresetId(): string {
  return `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the `GardenPresetDef` the setup screen renders/uses for a freshly-edited layout. */
export function buildCustomPresetDef(
  id: string,
  label: string,
  description: string,
  boardSize: number,
  gardens: Array<{ pos: Pos; type: PlantableGardenType }>,
): GardenPresetDef {
  return {
    id,
    label,
    description: description.trim() || 'A custom garden layout.',
    minBoardSize: boardSize,
    build: () => gardens,
  };
}

/** Trigger a browser download of a custom preset as a standalone .json file. */
export function downloadCustomPreset(def: GardenPresetDef, boardSize: number): void {
  const file: CustomPresetFile = {
    kind: CUSTOM_PRESET_FILE_KIND,
    version: CUSTOM_PRESET_FILE_VERSION,
    label: def.label,
    description: def.description,
    boardSize,
    gardens: def.build(boardSize),
  };
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(def.label)}.whimsy-preset.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function slugify(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'custom-preset';
}

/** Parse+validate an imported preset file. Throws a human-readable Error on anything malformed. */
export function parseCustomPresetFile(raw: string): GardenPresetDef {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (typeof data !== 'object' || data === null) throw new Error('That file is not a garden preset.');
  const f = data as Partial<CustomPresetFile>;
  if (f.kind !== CUSTOM_PRESET_FILE_KIND) throw new Error('That file is not a Whimsy Wars garden preset.');
  if (typeof f.version !== 'number' || f.version > CUSTOM_PRESET_FILE_VERSION) {
    throw new Error('That preset was saved by a newer version of Whimsy Wars.');
  }
  if (typeof f.label !== 'string' || f.label.trim() === '') throw new Error('The preset has no name.');
  if (typeof f.boardSize !== 'number' || !Number.isInteger(f.boardSize) || f.boardSize < 5 || f.boardSize % 2 === 0) {
    throw new Error('The preset has an invalid board size.');
  }
  if (!Array.isArray(f.gardens)) throw new Error('The preset has no garden layout.');

  const plantable = new Set<string>(PLANTABLE_GARDEN_TYPES);
  const reserved = new Set(reservedHomePositions(f.boardSize).map(posKey));
  const seen = new Set<string>();
  const gardens: Array<{ pos: Pos; type: PlantableGardenType }> = [];
  for (const g of f.gardens) {
    const pos = (g as { pos?: Pos }).pos;
    const type = (g as { type?: string }).type;
    if (
      !pos ||
      !Number.isInteger(pos.x) ||
      !Number.isInteger(pos.y) ||
      pos.x < 0 ||
      pos.y < 0 ||
      pos.x >= f.boardSize ||
      pos.y >= f.boardSize
    ) {
      throw new Error('The preset has a garden outside the board.');
    }
    if (!type || !plantable.has(type)) throw new Error(`The preset has an unknown garden type "${String(type)}".`);
    const key = posKey(pos);
    if (reserved.has(key)) throw new Error(`The preset places a garden on a Home Garden space (${key}).`);
    if (seen.has(key)) throw new Error(`The preset has more than one garden at ${key}.`);
    seen.add(key);
    gardens.push({ pos: { x: pos.x, y: pos.y }, type: type as PlantableGardenType });
  }

  return buildCustomPresetDef(
    makeCustomPresetId(),
    f.label.trim().slice(0, PRESET_LABEL_MAX_LENGTH),
    typeof f.description === 'string' ? f.description.slice(0, PRESET_DESCRIPTION_MAX_LENGTH) : '',
    f.boardSize,
    gardens,
  );
}
