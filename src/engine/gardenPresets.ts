/**
 * Garden preset registry: named layouts of additional (non-home) gardens.
 *
 * To add a new preset, append one entry to `GARDEN_PRESETS` below — nothing
 * else needs to change. `setup.ts` looks presets up by id (no hardcoded
 * switch), and `SetupScreen.tsx` renders the menu straight from this array.
 *
 * Positions scale with board size N, center c = (N - 1) / 2 (shown for the
 * default 7×7, so c = 3). Every preset garden consumes tiles from the shared
 * supply (8 per type, see `SUPPLY_PER_TYPE`), so a preset must not use more
 * than 8 of any one type.
 */

import type { PlantableGardenType, Pos } from './types';

export interface GardenPresetDef {
  /** Stable identifier — this is the value stored on `GameConfig.gardenPreset`. */
  id: string;
  /** Short menu label. */
  label: string;
  /** One-line blurb shown under the menu once selected. */
  description: string;
  /** Smallest boardSize this layout fits on (its slots need room around the center). */
  minBoardSize: number;
  /** Compute the garden positions for a given (odd) board size. */
  build: (boardSize: number) => Array<{ pos: Pos; type: PlantableGardenType }>;
  /**
   * Optional override of where the 4 Home Gardens sit (seat order
   * west/north/east/south by convention; 2-player games use indices 0 and
   * 2). Only player-built custom presets set this — built-in presets leave
   * it undefined and use the standard edge-midpoint formula
   * (`homePositions`) for whatever player count is chosen.
   */
  homes?: Pos[];
}

export const GARDEN_PRESETS: readonly GardenPresetDef[] = [
  {
    id: 'none',
    label: 'None',
    description: 'Homes only (+ Center Star, if enabled). The purest race.',
    minBoardSize: 5,
    build: () => [],
  },
  {
    id: 'few',
    label: 'Few (tunnels)',
    description: 'Four Tunnel Gardens in a corner ring — a mobility loop every seat can use.',
    minBoardSize: 7,
    build: (n) => tunnelCorners(n),
  },
  {
    id: 'orchard',
    label: 'Orchard',
    description: 'Four Dandelion Gardens, one guarding each home approach. Calm, economy-focused.',
    minBoardSize: 7,
    build: (n) => midEdges(n, 'dandelion'),
  },
  {
    id: 'fortress',
    label: 'Fortress',
    description: 'Maize Gardens tax the approaches; Mushroom Gardens behind them rebuild your army. Slow and defensive.',
    minBoardSize: 7,
    build: (n) => [...midEdges(n, 'maize'), ...innerCross(n, 'mushroom')],
  },
  {
    id: 'gauntlet',
    label: 'Gauntlet',
    description: 'Slippery corners fling you inward, straight at a ring of Flytraps guarding the center. Chaotic.',
    minBoardSize: 7,
    build: (n) => [...tunnelCorners(n, 'slippery'), ...innerDiagonals(n, 'flytrap')],
  },
  {
    id: 'many',
    label: 'Many',
    description: 'Tunnels, Dandelions, Mushrooms and Flytraps together (16 gardens) — a bit of everything.',
    minBoardSize: 7,
    build: (n) => [
      ...tunnelCorners(n),
      ...midEdges(n, 'dandelion'),
      ...innerCross(n, 'mushroom'),
      ...innerDiagonals(n, 'flytrap'),
    ],
  },
];

export const DEFAULT_GARDEN_PRESET_ID = 'none';

/** Look up a preset by id, or `undefined` if the id isn't registered. */
export function findGardenPreset(id: string): GardenPresetDef | undefined {
  return GARDEN_PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Shared slot geometry (4-fold rotationally symmetric around the center, so
// every preset is fair for both the 2-player west/east and 4-player seatings)
// ---------------------------------------------------------------------------

/** Outer corner ring: (1,1) (n-2,1) (1,n-2) (n-2,n-2). Default type 'tunnel'. */
function tunnelCorners(n: number, type: PlantableGardenType = 'tunnel'): Array<{ pos: Pos; type: PlantableGardenType }> {
  return [
    { pos: { x: 1, y: 1 }, type },
    { pos: { x: n - 2, y: 1 }, type },
    { pos: { x: 1, y: n - 2 }, type },
    { pos: { x: n - 2, y: n - 2 }, type },
  ];
}

/** One slot near each home approach: (1,c) (c,1) (n-2,c) (c,n-2). */
function midEdges(n: number, type: PlantableGardenType): Array<{ pos: Pos; type: PlantableGardenType }> {
  const c = (n - 1) / 2;
  return [
    { pos: { x: 1, y: c }, type },
    { pos: { x: c, y: 1 }, type },
    { pos: { x: n - 2, y: c }, type },
    { pos: { x: c, y: n - 2 }, type },
  ];
}

/** Orthogonal ring hugging the center: (c-1,c) (c,c-1) (c+1,c) (c,c+1). */
function innerCross(n: number, type: PlantableGardenType): Array<{ pos: Pos; type: PlantableGardenType }> {
  const c = (n - 1) / 2;
  return [
    { pos: { x: c - 1, y: c }, type },
    { pos: { x: c, y: c - 1 }, type },
    { pos: { x: c + 1, y: c }, type },
    { pos: { x: c, y: c + 1 }, type },
  ];
}

/** Diagonal ring hugging the center: (c±1, c±1). */
function innerDiagonals(n: number, type: PlantableGardenType): Array<{ pos: Pos; type: PlantableGardenType }> {
  const c = (n - 1) / 2;
  return [
    { pos: { x: c - 1, y: c - 1 }, type },
    { pos: { x: c + 1, y: c - 1 }, type },
    { pos: { x: c - 1, y: c + 1 }, type },
    { pos: { x: c + 1, y: c + 1 }, type },
  ];
}
