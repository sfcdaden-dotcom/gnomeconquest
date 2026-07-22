/**
 * Game creation: config validation, board layout presets, initial state,
 * and the turn-order roll-off (surfaced as `rollOff` decisions).
 *
 * Home Gardens (equidistant edge midpoints, seats clockwise; N = boardSize,
 * center c = (N-1)/2 — shown for the default 7×7, so c = 3):
 *   2 players: seat 0 west (0,3), seat 1 east (6,3)
 *   4 players: seat 0 west (0,3), seat 1 north (3,0), seat 2 east (6,3),
 *              seat 3 south (3,6)
 * A caller may override this via `customHomes` (e.g. a preset built in the
 * in-game editor that moved the homes) — see `homePositions` below.
 *
 * Additional-garden layouts ("presets") are registered in gardenPresets.ts —
 * see that file for the list and for how to add a new one.
 */

import type {
  CreateGameOptions,
  GameConfig,
  GameState,
  GardenPreset,
  PlantableGardenType,
  PlayerId,
  PlayerState,
  Pos,
} from './types';
import { EngineError } from './types';
import { normalizeSeed } from './rng';
import { posKey } from './helpers';
import { makeGarden } from './gardens';
import { buildInitialDeck } from './cards';
import { DEFAULT_GARDEN_PRESET_ID, findGardenPreset } from './gardenPresets';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  boardSize: 7,
  startingWishes: 3,
  wishLimit: 5,
  gnomeBoardLimit: 8,
  totalReinforcements: 16,
  handLimit: 7,
  centerStar: true,
  gardenPreset: DEFAULT_GARDEN_PRESET_ID as GardenPreset,
} as const;

/** Shared supply: 8 tiles of each plantable type, game-wide. */
export const SUPPLY_PER_TYPE = 8;

/** Every type a player can plant/design a garden layout with (excludes 'home'). */
export const PLANTABLE_GARDEN_TYPES: readonly PlantableGardenType[] = [
  'dandelion',
  'mushroom',
  'flytrap',
  'maize',
  'slippery',
  'tunnel',
];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Home garden positions for a seating (clockwise). */
export function homePositions(boardSize: number, playerCount: number): Pos[] {
  const c = (boardSize - 1) / 2;
  const west = { x: 0, y: c };
  const north = { x: c, y: 0 };
  const east = { x: boardSize - 1, y: c };
  const south = { x: c, y: boardSize - 1 };
  return playerCount === 2 ? [west, east] : [west, north, east, south];
}

/** Additional-garden preset positions (registry: gardenPresets.ts). */
export function presetGardens(boardSize: number, preset: GardenPreset): Array<{ pos: Pos; type: PlantableGardenType }> {
  const def = findGardenPreset(preset);
  if (!def) badConfig(`Unknown gardenPreset "${preset}"`);
  return def.build(boardSize);
}

// ---------------------------------------------------------------------------
// createGame
// ---------------------------------------------------------------------------

function badConfig(message: string): never {
  throw new EngineError('BAD_CONFIG', message);
}

function resolveConfig(options: CreateGameOptions): GameConfig {
  const playerCount = options.players.length;
  if (playerCount !== 2 && playerCount !== 4) badConfig('Whimsy Wars supports exactly 2 or 4 players');
  const boardSize = options.boardSize ?? DEFAULT_CONFIG.boardSize;
  if (!Number.isInteger(boardSize) || boardSize < 5 || boardSize % 2 === 0) {
    badConfig('boardSize must be an odd integer >= 5');
  }
  const customHomes = options.customHomes;
  if (customHomes) {
    if (customHomes.length !== playerCount) {
      badConfig(`customHomes must have exactly ${playerCount} position(s), got ${customHomes.length}`);
    }
    const seen = new Set<string>();
    for (const pos of customHomes) {
      if (!Number.isInteger(pos.x) || !Number.isInteger(pos.y) || pos.x < 0 || pos.y < 0 || pos.x >= boardSize || pos.y >= boardSize) {
        badConfig(`customHomes position (${pos.x},${pos.y}) is out of bounds for boardSize ${boardSize}`);
      }
      const key = posKey(pos);
      if (seen.has(key)) badConfig(`customHomes has more than one home at ${key}`);
      seen.add(key);
    }
  }
  const gardenPreset = options.gardenPreset ?? DEFAULT_CONFIG.gardenPreset;
  const customGardens = options.customGardens;
  if (customGardens) {
    const plantable = new Set<string>(PLANTABLE_GARDEN_TYPES);
    const seen = new Set<string>();
    for (const g of customGardens) {
      if (!Number.isInteger(g.pos.x) || !Number.isInteger(g.pos.y) || g.pos.x < 0 || g.pos.y < 0 || g.pos.x >= boardSize || g.pos.y >= boardSize) {
        badConfig(`customGardens position (${g.pos.x},${g.pos.y}) is out of bounds for boardSize ${boardSize}`);
      }
      if (!plantable.has(g.type)) badConfig(`customGardens has an invalid garden type "${g.type}"`);
      const key = posKey(g.pos);
      if (seen.has(key)) badConfig(`customGardens has more than one garden at ${key}`);
      seen.add(key);
    }
  } else {
    const presetDef = findGardenPreset(gardenPreset);
    if (!presetDef) badConfig(`Unknown gardenPreset "${gardenPreset}"`);
    if (boardSize < presetDef.minBoardSize) {
      badConfig(`gardenPreset "${gardenPreset}" requires boardSize >= ${presetDef.minBoardSize}`);
    }
  }
  const cfg: GameConfig = {
    boardSize,
    startingWishes: options.startingWishes ?? DEFAULT_CONFIG.startingWishes,
    wishLimit: options.wishLimit ?? DEFAULT_CONFIG.wishLimit,
    gnomeBoardLimit: options.gnomeBoardLimit ?? DEFAULT_CONFIG.gnomeBoardLimit,
    totalReinforcements: options.totalReinforcements ?? DEFAULT_CONFIG.totalReinforcements,
    handLimit: options.handLimit ?? DEFAULT_CONFIG.handLimit,
    centerStar: options.centerStar ?? DEFAULT_CONFIG.centerStar,
    gardenPreset,
    ...(customGardens ? { customGardens } : {}),
    ...(customHomes ? { customHomes } : {}),
    players: options.players.map((p, i) => ({
      name: p.name ?? `Player ${i + 1}`,
      controller: p.controller,
      difficulty: p.difficulty ?? 'normal',
    })),
  };
  if (cfg.startingWishes < 0 || cfg.wishLimit < 1 || cfg.gnomeBoardLimit < 1) badConfig('Limits must be positive');
  if (cfg.startingWishes > cfg.wishLimit) badConfig('startingWishes cannot exceed wishLimit');
  if (cfg.totalReinforcements < cfg.gnomeBoardLimit) {
    badConfig('totalReinforcements must be >= gnomeBoardLimit');
  }
  if (cfg.handLimit < 1) badConfig('handLimit must be >= 1');
  return cfg;
}

/**
 * Create a new game. The returned state is in the turn-order roll-off:
 * `state.pendingDecision` asks each seat in order to submit a `rollOff`
 * action; highest roll goes first (ties reroll among the tied), then play
 * proceeds clockwise. Players start with 0 gnomes on the board.
 */
export function createGame(options: CreateGameOptions, seed: number): GameState {
  const config = resolveConfig(options);
  const homes = config.customHomes ?? homePositions(config.boardSize, config.players.length);

  const players: PlayerState[] = config.players.map((p, i) => ({
    id: i as PlayerId,
    name: p.name,
    controller: p.controller,
    difficulty: p.difficulty,
    status: 'playing',
    wishes: config.startingWishes,
    hand: [],
    gnomesSpawned: 0,
    gnomesLost: 0,
    homePos: homes[i],
  }));

  const supply: Record<PlantableGardenType, number> = {
    dandelion: SUPPLY_PER_TYPE,
    mushroom: SUPPLY_PER_TYPE,
    flytrap: SUPPLY_PER_TYPE,
    maize: SUPPLY_PER_TYPE,
    slippery: SUPPLY_PER_TYPE,
    tunnel: SUPPLY_PER_TYPE,
  };

  const state: GameState = {
    schemaVersion: 1,
    config,
    seed,
    rngState: normalizeSeed(seed),
    status: 'rolloff',
    rolloff: {
      participants: players.map((p) => p.id),
      pending: players.map((p) => p.id),
      rolls: players.map(() => null),
    },
    players,
    gardens: {},
    units: {},
    supply,
    deck: [],
    discard: [],
    cursePool: [],
    activeCurses: [],
    turn: null,
    harvest: null,
    fight: null,
    fightQueue: [],
    cardStack: [],
    responseQueue: [],
    rollModifiers: players.map(() => 0),
    preventionShields: 0,
    marriages: [],
    timedEffects: [],
    eliminationQueue: [],
    turnMustEnd: false,
    pendingDecision: { kind: 'rollOff', player: players[0].id },
    winner: null,
    nextUnitId: 1,
    nextFightId: 1,
    events: [],
    eventCount: 0,
  };

  // Home gardens.
  for (const p of players) {
    state.gardens[posKey(p.homePos)] = makeGarden('home', 0, p.id);
  }

  // Preset (or custom) gardens (consume shared supply).
  const layout = config.customGardens ?? presetGardens(config.boardSize, config.gardenPreset);
  for (const g of layout) {
    const key = posKey(g.pos);
    if (state.gardens[key]) badConfig(`Preset layout collision at ${key}`);
    if (state.supply[g.type] <= 0) badConfig(`Preset layout exhausts the ${g.type} supply`);
    state.supply[g.type] -= 1;
    state.gardens[key] = makeGarden(g.type, 0);
  }

  // Whimsy deck: 2 copies of each of the 23 cards, shuffled (see cards.ts).
  buildInitialDeck(state);

  return state;
}
