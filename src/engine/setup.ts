/**
 * Game creation: config validation, board layout presets, initial state,
 * and the turn-order roll-off (surfaced as `rollOff` decisions).
 *
 * BOARD LAYOUTS (documented here; positions scale with board size N, center
 * c = (N-1)/2 — shown for the default 7×7, so c = 3):
 *
 * Home Gardens (equidistant edge midpoints, seats clockwise):
 *   2 players: seat 0 west (0,3), seat 1 east (6,3)
 *   4 players: seat 0 west (0,3), seat 1 north (3,0), seat 2 east (6,3),
 *              seat 3 south (3,6)
 *
 * Preset 'none': homes (+ Center Star at (3,3) if enabled) only.
 *
 * Preset 'few' — 4 Tunnel Gardens, 4-fold symmetric around the center:
 *   (1,1)  (5,1)
 *   (1,5)  (5,5)
 *   Rationale: a mobility ring that lets every seat rotate around the board.
 *
 * Preset 'many' — 'few' plus a symmetric economy/defense mix (16 gardens):
 *   Tunnels    ×4: (1,1) (5,1) (1,5) (5,5)      — corner mobility
 *   Dandelions ×4: (1,3) (3,1) (5,3) (3,5)      — one near each home approach
 *   Mushrooms  ×4: (2,3) (3,2) (4,3) (3,4)      — contested clone ring by center
 *   Flytraps   ×4: (2,2) (4,2) (2,4) (4,4)      — hazards guarding the center
 *   All positions are 4-fold rotationally symmetric, so the layout is fair
 *   for both the 2-player (west/east) and 4-player seatings.
 *
 * Every preset garden consumes tiles from the shared supply (8 per type).
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
  gardenPreset: 'none' as GardenPreset,
} as const;

/** Shared supply: 8 tiles of each plantable type, game-wide. */
export const SUPPLY_PER_TYPE = 8;

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

/** Additional-garden preset positions (see file header for rationale). */
export function presetGardens(boardSize: number, preset: GardenPreset): Array<{ pos: Pos; type: PlantableGardenType }> {
  if (preset === 'none') return [];
  const n = boardSize;
  const c = (n - 1) / 2;
  const tunnels: Array<{ pos: Pos; type: PlantableGardenType }> = [
    { pos: { x: 1, y: 1 }, type: 'tunnel' },
    { pos: { x: n - 2, y: 1 }, type: 'tunnel' },
    { pos: { x: 1, y: n - 2 }, type: 'tunnel' },
    { pos: { x: n - 2, y: n - 2 }, type: 'tunnel' },
  ];
  if (preset === 'few') return tunnels;
  return [
    ...tunnels,
    { pos: { x: 1, y: c }, type: 'dandelion' },
    { pos: { x: c, y: 1 }, type: 'dandelion' },
    { pos: { x: n - 2, y: c }, type: 'dandelion' },
    { pos: { x: c, y: n - 2 }, type: 'dandelion' },
    { pos: { x: c - 1, y: c }, type: 'mushroom' },
    { pos: { x: c, y: c - 1 }, type: 'mushroom' },
    { pos: { x: c + 1, y: c }, type: 'mushroom' },
    { pos: { x: c, y: c + 1 }, type: 'mushroom' },
    { pos: { x: c - 1, y: c - 1 }, type: 'flytrap' },
    { pos: { x: c + 1, y: c - 1 }, type: 'flytrap' },
    { pos: { x: c - 1, y: c + 1 }, type: 'flytrap' },
    { pos: { x: c + 1, y: c + 1 }, type: 'flytrap' },
  ];
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
  const gardenPreset = options.gardenPreset ?? DEFAULT_CONFIG.gardenPreset;
  if (gardenPreset !== 'none' && boardSize < 7) {
    badConfig(`gardenPreset "${gardenPreset}" requires boardSize >= 7`);
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
    players: options.players.map((p, i) => ({
      name: p.name ?? `Player ${i + 1}`,
      controller: p.controller,
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
  const homes = homePositions(config.boardSize, config.players.length);

  const players: PlayerState[] = config.players.map((p, i) => ({
    id: i as PlayerId,
    name: p.name,
    controller: p.controller,
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

  // Preset gardens (consume shared supply).
  for (const g of presetGardens(config.boardSize, config.gardenPreset)) {
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
