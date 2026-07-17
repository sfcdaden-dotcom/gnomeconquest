/**
 * Internal shared helpers. Pure functions over GameState (read-only queries)
 * and small mutators used on the cloned draft inside applyAction.
 * Not part of the public API surface except where re-exported by index.ts
 * (posKey/parsePos and the read-only queries are safe for UI use).
 */

import type {
  EliminationReason,
  GameEvent,
  GameState,
  Garden,
  PlayerId,
  PlayerState,
  Pos,
  PosKey,
  TurnState,
  Unit,
  UnitId,
} from './types';
import { EngineError } from './types';
import { rollDie, shuffled } from './rng';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function illegal(message: string): never {
  throw new EngineError('ILLEGAL_ACTION', message);
}

export function badArg(message: string): never {
  throw new EngineError('BAD_ARGUMENT', message);
}

export function internal(message: string): never {
  throw new EngineError('INTERNAL', message);
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export function posKey(p: Pos): PosKey {
  return `${p.x},${p.y}`;
}

export function parsePos(key: PosKey): Pos {
  const idx = key.indexOf(',');
  return { x: Number(key.slice(0, idx)), y: Number(key.slice(idx + 1)) };
}

export function samePos(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

export function inBounds(state: GameState, p: Pos): boolean {
  const n = state.config.boardSize;
  return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < n && p.y < n;
}

export function isOrthAdjacent(a: Pos, b: Pos): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

export function manhattan(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Orthogonal on-board neighbors. */
export function orthNeighbors(state: GameState, p: Pos): Pos[] {
  const out: Pos[] = [];
  const deltas = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ];
  for (const d of deltas) {
    const q = { x: p.x + d.x, y: p.y + d.y };
    if (inBounds(state, q)) out.push(q);
  }
  return out;
}

/** All 8 on-board neighbors (orthogonal + diagonal). */
export function allNeighbors(state: GameState, p: Pos): Pos[] {
  const out: Pos[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const q = { x: p.x + dx, y: p.y + dy };
      if (inBounds(state, q)) out.push(q);
    }
  }
  return out;
}

/** Center space (Center Star lives here when enabled). */
export function centerPos(state: GameState): Pos {
  const c = (state.config.boardSize - 1) / 2;
  return { x: c, y: c };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getPlayer(state: GameState, id: PlayerId): PlayerState {
  const p = state.players[id];
  if (!p) badArg(`No such player: ${id}`);
  return p;
}

export function requireTurn(state: GameState): TurnState {
  if (!state.turn) internal('No active turn');
  return state.turn;
}

export function gardenAt(state: GameState, p: Pos): Garden | null {
  return state.gardens[posKey(p)] ?? null;
}

/** All units standing on a space, sorted by unit id for determinism. */
export function unitsAt(state: GameState, p: Pos): Unit[] {
  const out: Unit[] = [];
  for (const u of Object.values(state.units)) {
    if (samePos(u.pos, p)) out.push(u);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function playerUnitsAt(state: GameState, p: Pos, player: PlayerId): Unit[] {
  return unitsAt(state, p).filter((u) => u.owner === player);
}

export function enemyUnitsAt(state: GameState, p: Pos, player: PlayerId): Unit[] {
  return unitsAt(state, p).filter((u) => u.owner !== player);
}

/** All of a player's units, sorted by id. */
export function playerUnits(state: GameState, player: PlayerId): Unit[] {
  const out = Object.values(state.units).filter((u) => u.owner === player);
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function gnomesOnBoard(state: GameState, player: PlayerId): number {
  return playerUnits(state, player).filter((u) => u.kind === 'gnome').length;
}

export function reserveGnomes(state: GameState, player: PlayerId): number {
  const p = getPlayer(state, player);
  return state.config.totalReinforcements - p.gnomesSpawned;
}

/** A garden is Active once the turn it was planted on has ended. */
export function gardenIsActive(state: GameState, garden: Garden): boolean {
  const turnNumber = state.turn ? state.turn.number : 1;
  return garden.plantedOnTurn < turnNumber;
}

/** Current wish cap: base limit, +1 while the player occupies the Center Star. */
export function wishCap(state: GameState, player: PlayerId): number {
  let cap = state.config.wishLimit;
  if (state.config.centerStar) {
    const c = centerPos(state);
    if (playerUnitsAt(state, c, player).length > 0) cap += 1;
  }
  return cap;
}

/**
 * Maize exit cost for a unit leaving `from`, or 0 when no active maize garden
 * is there. (A maize garden planted this turn does not tax exits yet —
 * see ENGINE_API.md "interpretations".)
 */
export function maizeExitCost(state: GameState, from: Pos): number {
  const g = gardenAt(state, from);
  if (!g || g.type !== 'maize' || !gardenIsActive(state, g)) return 0;
  return g.doubledForPlayerTurn !== null ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Curses & timed effects
// ---------------------------------------------------------------------------

/** Curse card ids (see cards.ts CURSE_DEFINITIONS). */
export const CURSE_COMPOST = 'curse-compost-combustion';
export const CURSE_SNAILMAGGEDON = 'curse-snailmaggedon';
export const CURSE_MAGIC_DRAIN = 'curse-magic-drain';
export const CURSE_MULCH_FEVER = 'curse-mulch-fever';
export const CURSE_ANTSY_PANTS = 'curse-antsy-pants';

export function curseActive(state: GameState, curseId: string): boolean {
  return state.activeCurses.includes(curseId);
}

/** Planting cost: 1 Wish, or 2 under the Compost Combustion curse. */
export function plantWishCost(state: GameState): number {
  return curseActive(state, CURSE_COMPOST) ? 2 : 1;
}

/** Great Wall Of Whimsy: is entering `pos` currently forbidden? */
export function entryBlockedByWall(state: GameState, pos: Pos): boolean {
  if (!gardenAt(state, pos)) return false; // wall dies with its garden
  return state.timedEffects.some((e) => e.kind === 'greatWall' && e.pos !== undefined && samePos(e.pos, pos));
}

export function lostInMaizeActive(state: GameState): boolean {
  return state.timedEffects.some((e) => e.kind === 'lostInMaize');
}

/**
 * Lost In The Maize: gnomes cannot leave an Active Maize Garden at all
 * (paying, sliding, tunneling and card effects included). Returns a reason
 * string when the unit is locked in, else null. Snails are unaffected.
 */
export function gnomeExitBlocked(state: GameState, unit: Unit): string | null {
  if (unit.kind !== 'gnome') return null;
  if (!lostInMaizeActive(state)) return null;
  const g = gardenAt(state, unit.pos);
  if (g && g.type === 'maize' && gardenIsActive(state, g)) {
    return 'Lost In The Maize: gnomes cannot leave Maize Gardens right now';
  }
  return null;
}

/** All other players still holding cards' rights (status 'playing'), in seat
 *  order starting clockwise after `player`. Used for card response windows. */
export function otherPlayingPlayers(state: GameState, player: PlayerId): PlayerId[] {
  const n = state.players.length;
  const out: PlayerId[] = [];
  for (let i = 1; i <= n; i++) {
    const cand = (player + i) % n;
    if (cand === player) continue;
    if (state.players[cand].status === 'playing') out.push(cand);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Draft mutators (only ever called on the cloned draft inside applyAction)
// ---------------------------------------------------------------------------

export function pushEvent(draft: GameState, ev: GameEvent): void {
  draft.events.push(ev);
  draft.eventCount += 1;
}

/** Roll a d6 using (and advancing) the draft's RNG state. */
export function draftRollD6(draft: GameState): number {
  const r = rollDie(draft.rngState, 6);
  draft.rngState = r.state;
  return r.value;
}

/**
 * Roll a d6 FOR A PLAYER: applies and consumes any pending "next dice roll"
 * modifiers (Snake Eyes −2 / 4 Leaf Clover +3, stacking, floored at 0).
 * System rolls (the flytrap's die) use draftRollD6 directly.
 */
export function rollPlayerD6(draft: GameState, player: PlayerId): number {
  const raw = draftRollD6(draft);
  const modifier = draft.rollModifiers[player] ?? 0;
  if (modifier === 0) return raw;
  const result = Math.max(0, raw + modifier);
  draft.rollModifiers[player] = 0;
  pushEvent(draft, { type: 'rollModified', player, raw, modifier, result });
  return result;
}

/** Shuffle an array using (and advancing) the draft's RNG state. */
export function draftShuffle<T>(draft: GameState, items: readonly T[]): T[] {
  const r = shuffled(draft.rngState, items);
  draft.rngState = r.state;
  return r.value;
}

/** Uniform int in [0, maxExclusive) using the draft's RNG state. */
export function draftInt(draft: GameState, maxExclusive: number): number {
  const r = rollDie(draft.rngState, maxExclusive);
  draft.rngState = r.state;
  return r.value - 1;
}

/**
 * Gain wishes up to the player's current cap; excess is lost (logged).
 * Returns the amount actually gained.
 */
export function gainWishes(draft: GameState, player: PlayerId, amount: number): number {
  const p = getPlayer(draft, player);
  const cap = wishCap(draft, player);
  const room = Math.max(0, cap - p.wishes);
  const gained = Math.min(amount, room);
  p.wishes += gained;
  pushEvent(draft, { type: 'wishesGained', player, requested: amount, gained, lost: amount - gained });
  return gained;
}

export function spendWishes(draft: GameState, player: PlayerId, amount: number, reason: string): void {
  const p = getPlayer(draft, player);
  if (p.wishes < amount) illegal(`${p.name} cannot pay ${amount} Wish(es) for ${reason} (has ${p.wishes})`);
  p.wishes -= amount;
  pushEvent(draft, { type: 'wishesSpent', player, amount, reason });
}

/** Can this player legally receive one more gnome on the board right now? */
export function canSpawnGnome(state: GameState, player: PlayerId): boolean {
  return (
    gnomesOnBoard(state, player) < state.config.gnomeBoardLimit &&
    reserveGnomes(state, player) > 0
  );
}

/** Spawn a gnome for `player` at `pos`. Caller must have checked canSpawnGnome. */
export function spawnGnome(draft: GameState, player: PlayerId, pos: Pos): Unit {
  if (!canSpawnGnome(draft, player)) internal(`spawnGnome called at limit for player ${player}`);
  const p = getPlayer(draft, player);
  const unit: Unit = {
    id: `u${draft.nextUnitId++}`,
    owner: player,
    kind: 'gnome',
    pos: { x: pos.x, y: pos.y },
    movedOnTurn: null,
  };
  draft.units[unit.id] = unit;
  p.gnomesSpawned += 1;
  pushEvent(draft, { type: 'gnomeSpawned', player, unitId: unit.id, pos: unit.pos });
  return unit;
}

/**
 * Destroy a unit. Returns true if the unit was actually destroyed.
 *
 * - Gnomebody Dies: while prevention shields are up, the next gnome
 *   destruction this turn (any owner) is prevented instead (one per shield).
 * - Gnomio & Juliet: destroying a married gnome also destroys its partner(s);
 *   partner destructions are destructions themselves (preventable, and
 *   marriage chains cascade).
 * - Gnome losses count toward reinforcement elimination; the elimination is
 *   queued and processed by the engine's settle loop.
 */
export function destroyUnit(draft: GameState, unitId: UnitId, cause: string): boolean {
  const u = draft.units[unitId];
  if (!u) return false;
  if (u.kind === 'gnome' && draft.preventionShields > 0) {
    draft.preventionShields -= 1;
    pushEvent(draft, { type: 'destructionPrevented', player: u.owner, unitId });
    return false;
  }
  delete draft.units[unitId];
  pushEvent(draft, { type: 'unitDestroyed', player: u.owner, unitId, pos: u.pos, cause });
  if (u.kind === 'gnome') {
    const p = getPlayer(draft, u.owner);
    p.gnomesLost += 1;
    if (p.gnomesLost >= draft.config.totalReinforcements) {
      queueElimination(draft, u.owner, 'reinforcements');
    }
  }
  // Marriage cascade (the unit is already gone, so chains terminate).
  const partners: UnitId[] = [];
  draft.marriages = draft.marriages.filter(([a, b]) => {
    if (a === unitId) {
      partners.push(b);
      return false;
    }
    if (b === unitId) {
      partners.push(a);
      return false;
    }
    return true;
  });
  for (const partner of partners) {
    destroyUnit(draft, partner, 'marriage');
  }
  return true;
}

/**
 * Remove marriages that reference `unitId` WITHOUT cascading (used when units
 * are removed rather than destroyed, e.g. player elimination cleanup).
 */
export function dissolveMarriages(draft: GameState, unitId: UnitId): void {
  draft.marriages = draft.marriages.filter(([a, b]) => a !== unitId && b !== unitId);
}

/** If over the hand limit, require immediate discards (decision). */
export function enforceHandLimit(draft: GameState, player: PlayerId): void {
  const p = getPlayer(draft, player);
  const over = p.hand.length - draft.config.handLimit;
  if (over > 0) {
    draft.pendingDecision = { kind: 'discard', player, mustDiscard: over };
  }
}

export function queueElimination(draft: GameState, player: PlayerId, reason: EliminationReason): void {
  const p = getPlayer(draft, player);
  if (p.status !== 'playing') return;
  if (draft.eliminationQueue.some((e) => e.player === player)) return;
  draft.eliminationQueue.push({ player, reason });
}

/**
 * If `pos` holds someone's Home Garden and it is now solely occupied by enemy
 * units, queue the owner's elimination. Called after fights resolve and after
 * un-contested entries.
 */
export function checkHomeCapture(draft: GameState, pos: Pos): void {
  const g = gardenAt(draft, pos);
  if (!g || g.type !== 'home' || g.owner === undefined) return;
  const occupants = unitsAt(draft, pos);
  if (occupants.length === 0) return;
  const owners = new Set(occupants.map((u) => u.owner));
  if (owners.size === 1 && !owners.has(g.owner)) {
    queueElimination(draft, g.owner, 'home-captured');
  }
}

/** Destroy a garden (snail / card / elimination). Non-home tiles return to supply. */
export function destroyGarden(draft: GameState, pos: Pos, cause: 'snail' | 'card' | 'elimination'): void {
  const key = posKey(pos);
  const g = draft.gardens[key];
  if (!g) return;
  delete draft.gardens[key];
  if (g.type !== 'home') {
    draft.supply[g.type] += 1;
  }
  pushEvent(draft, { type: 'gardenDestroyed', pos, gardenType: g.type, cause });
}
