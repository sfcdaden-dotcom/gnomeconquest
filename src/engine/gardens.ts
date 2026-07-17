/**
 * Garden effect logic: entry effects, the mandatory Harvest Phase machine,
 * and the per-garden harvest resolutions.
 *
 * Harvest Phase model (per the interaction-model requirement):
 *  - At turn start `beginHarvestPhase` snapshots every qualifying source into
 *    `draft.harvest.remaining`.
 *  - The settle loop calls `continueHarvest` until the phase is done:
 *      * >1 sources remaining  → `chooseHarvest` decision (owner picks order),
 *      *  1 source remaining   → resolved automatically (order can't matter),
 *      * a resolved source may surface inner decisions (home wish-or-gnome,
 *        mushroom clone count, slide/tunnel destinations) or queue fights
 *        (flytrap attacks).
 *  - Sources are re-validated when resolved: a garden vacated or invalidated
 *    by an earlier harvest (e.g. a slide moved the gnome away) is skipped.
 *    Gardens newly entered mid-harvest do NOT harvest this turn.
 */

import type {
  GameState,
  Garden,
  HarvestSource,
  HomeHarvestChoice,
  PlayerId,
  Pos,
  Unit,
  UnitId,
} from './types';
import {
  CURSE_SNAILMAGGEDON,
  allNeighbors,
  badArg,
  canSpawnGnome,
  curseActive,
  enemyUnitsAt,
  entryBlockedByWall,
  gainWishes,
  gardenAt,
  gardenIsActive,
  getPlayer,
  gnomesOnBoard,
  illegal,
  internal,
  maizeExitCost,
  orthNeighbors,
  parsePos,
  playerUnits,
  playerUnitsAt,
  posKey,
  pushEvent,
  queueElimination,
  requireTurn,
  reserveGnomes,
  rollPlayerD6,
  samePos,
  spawnGnome,
  wishCap,
} from './helpers';
import { queueFight } from './fights';

// ---------------------------------------------------------------------------
// Entry handling (movement, slides, tunnels, snail placement all funnel here)
// ---------------------------------------------------------------------------

/**
 * Process a unit's arrival on its current space:
 *  1. Active un-stunned flytrap here → mandatory fight vs the arriving unit
 *     (queued first).
 *  2. Enemy units here → fight(s) queued (one per distinct enemy owner).
 *  3. No fights → home-capture elimination check; then optional entry effect
 *     for gnomes on an Active slippery/tunnel garden.
 */
export function handleEntry(draft: GameState, unitId: UnitId): void {
  const unit = draft.units[unitId];
  if (!unit) return; // destroyed mid-chain
  const pos = unit.pos;
  const garden = gardenAt(draft, pos);
  let fights = 0;

  if (
    garden &&
    garden.type === 'flytrap' &&
    gardenIsActive(draft, garden) &&
    garden.stunnedForPlayerTurn === null
  ) {
    queueFight(draft, {
      pos: { ...pos },
      sides: [{ kind: 'flytrap' }, { kind: 'player', player: unit.owner }],
      targetUnit: unit.id,
      pinned: null,
      cause: 'entry',
    });
    fights += 1;
  }

  const enemies = enemyUnitsAt(draft, pos, unit.owner);
  const enemyOwners = [...new Set(enemies.map((u) => u.owner))].sort((a, b) => a - b);
  for (const owner of enemyOwners) {
    queueFight(draft, {
      pos: { ...pos },
      sides: [
        { kind: 'player', player: owner },
        { kind: 'player', player: unit.owner },
      ],
      targetUnit: null,
      pinned: null,
      cause: 'entry',
    });
    fights += 1;
  }

  if (fights > 0) return; // fights preempt entry effects and capture checks

  // Un-contested arrival on an enemy Home Garden ⇒ sole occupation ⇒ capture.
  if (garden && garden.type === 'home' && garden.owner !== undefined && garden.owner !== unit.owner) {
    queueElimination(draft, garden.owner, 'home-captured');
    return;
  }

  // Optional entry effects (gnomes only; garden must be Active).
  if (unit.kind !== 'gnome' || !garden || !gardenIsActive(draft, garden)) return;

  if (garden.type === 'slippery') {
    const options = orthNeighbors(draft, pos).filter((q) => !entryBlockedByWall(draft, q));
    if (options.length > 0) {
      draft.pendingDecision = {
        kind: 'slide',
        player: unit.owner,
        unitId: unit.id,
        from: { ...pos },
        options,
        optional: true,
        context: 'entry',
      };
    }
  } else if (garden.type === 'tunnel') {
    const options = otherTunnelPositions(draft, pos).filter((q) => !entryBlockedByWall(draft, q));
    if (options.length > 0) {
      draft.pendingDecision = {
        kind: 'tunnel',
        player: unit.owner,
        unitId: unit.id,
        from: { ...pos },
        options,
        optional: true,
        context: 'entry',
      };
    }
  }
}

function otherTunnelPositions(state: GameState, from: Pos): Pos[] {
  const out: Pos[] = [];
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== 'tunnel') continue;
    const p = parsePos(key);
    if (!samePos(p, from)) out.push(p);
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

/**
 * Tunnel HARVEST destinations: any other tunnel garden, OR any garden occupied
 * by one of the owner's gnomes. The tunnel being harvested is itself a garden
 * occupied by the owner's gnome, so "stay" is always an option (see
 * ENGINE_API.md "interpretations").
 */
function tunnelHarvestDestinations(state: GameState, from: Pos, player: PlayerId): Pos[] {
  const set = new Map<string, Pos>();
  for (const p of otherTunnelPositions(state, from)) set.set(posKey(p), p);
  for (const key of Object.keys(state.gardens)) {
    const p = parsePos(key);
    if (playerUnitsAt(state, p, player).some((u) => u.kind === 'gnome')) set.set(key, p);
  }
  const out = [...set.values()].filter((p) => samePos(p, from) || !entryBlockedByWall(state, p));
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

// ---------------------------------------------------------------------------
// Harvest phase machine
// ---------------------------------------------------------------------------

/** Snapshot every qualifying harvest source for the active player. */
export function beginHarvestPhase(draft: GameState): void {
  const t = requireTurn(draft);
  const player = getPlayer(draft, t.activePlayer);
  const sources: HarvestSource[] = [];

  // Home Garden: always produces, even unoccupied (if it still exists).
  const homeGarden = gardenAt(draft, player.homePos);
  if (homeGarden && homeGarden.type === 'home' && homeGarden.owner === player.id) {
    sources.push({ key: 'home', kind: 'home', pos: { ...player.homePos }, gardenType: 'home' });
  }

  const keys = Object.keys(draft.gardens).sort();
  for (const key of keys) {
    const g = draft.gardens[key];
    if (g.type === 'home') continue;
    const pos = parsePos(key);
    if (!gardenIsActive(draft, g)) continue;
    const ownGnomes = playerUnitsAt(draft, pos, player.id).filter((u) => u.kind === 'gnome');
    if (ownGnomes.length === 0) continue;
    if (g.type === 'flytrap') {
      if (g.stunnedForPlayerTurn === null) {
        sources.push({ key, kind: 'flytrap', pos, gardenType: 'flytrap' });
      }
      continue;
    }
    // Controlled = occupied only by this player's units.
    if (enemyUnitsAt(draft, pos, player.id).length > 0) continue;
    sources.push({ key, kind: 'garden', pos, gardenType: g.type });
  }

  // Snailmaggedon: every snail owner may move their snail 1 space during any
  // player's Harvest Phase (in turn order from the active player).
  const snailMoves: PlayerId[] = [];
  if (curseActive(draft, CURSE_SNAILMAGGEDON)) {
    const n = draft.players.length;
    for (let i = 1; i <= n; i++) {
      const cand = (player.id + i) % n;
      if (draft.players[cand].status === 'snail') snailMoves.push(cand);
    }
  }

  draft.harvest = { remaining: sources, moveQueue: [], snailMoves };
  pushEvent(draft, {
    type: 'harvestPhaseStarted',
    player: player.id,
    sources: sources.map((s) => s.key),
  });
}

/**
 * Advance the Harvest Phase. Called from the settle loop whenever there is no
 * pending decision and no fight. Guaranteed to make progress: it resolves a
 * source, surfaces a decision, or ends the phase.
 */
export function continueHarvest(draft: GameState): void {
  const t = requireTurn(draft);
  if (!draft.harvest) {
    // Deferred build (turn start may first need a Magic Drain sacrifice).
    beginHarvestPhase(draft);
    return;
  }
  const h = draft.harvest;

  // Snailmaggedon snail moves resolve before the active player's harvests.
  while (h.snailMoves.length > 0) {
    const owner = h.snailMoves[0];
    const snail = playerUnits(draft, owner).find((u) => u.kind === 'snail');
    if (!snail) {
      h.snailMoves.shift();
      continue;
    }
    // Snail owners have 0 Wishes, so any maize exit cost traps the snail.
    if (maizeExitCost(draft, snail.pos) > getPlayer(draft, owner).wishes) {
      h.snailMoves.shift();
      continue;
    }
    const options = orthNeighbors(draft, snail.pos).filter((q) => !entryBlockedByWall(draft, q));
    if (options.length === 0) {
      h.snailMoves.shift();
      continue;
    }
    draft.pendingDecision = {
      kind: 'snailMove',
      player: owner,
      unitId: snail.id,
      from: { ...snail.pos },
      options,
    };
    return;
  }

  // Pending per-gnome slides / tunnels of the current source come first.
  while (h.moveQueue.length > 0) {
    const mv = h.moveQueue[0];
    const unit = draft.units[mv.unitId];
    if (!unit || !samePos(unit.pos, mv.pos)) {
      h.moveQueue.shift(); // gnome destroyed or already moved away
      continue;
    }
    if (mv.effect === 'slippery') {
      // Diagonals allowed on harvest slides; Great Wall blocks destinations.
      const options = allNeighbors(draft, mv.pos).filter((q) => !entryBlockedByWall(draft, q));
      if (options.length === 0) {
        h.moveQueue.shift();
        pushEvent(draft, { type: 'harvestSkipped', sourceKey: posKey(mv.pos), reason: 'no slide destination' });
        continue;
      }
      draft.pendingDecision = {
        kind: 'slide',
        player: unit.owner,
        unitId: unit.id,
        from: { ...mv.pos },
        options,
        optional: false,
        context: 'harvest',
      };
      return;
    }
    const options = tunnelHarvestDestinations(draft, mv.pos, unit.owner);
    if (options.length === 0) {
      h.moveQueue.shift();
      pushEvent(draft, { type: 'harvestSkipped', sourceKey: posKey(mv.pos), reason: 'no tunnel destination' });
      continue;
    }
    draft.pendingDecision = {
      kind: 'tunnel',
      player: unit.owner,
      unitId: unit.id,
      from: { ...mv.pos },
      options,
      optional: false,
      context: 'harvest',
    };
    return;
  }

  if (h.remaining.length === 0) {
    draft.harvest = null;
    t.phase = 'action';
    pushEvent(draft, { type: 'actionPhaseStarted', player: t.activePlayer });
    return;
  }

  if (h.remaining.length === 1) {
    resolveHarvestSourceByKey(draft, h.remaining[0].key);
    return;
  }

  draft.pendingDecision = {
    kind: 'chooseHarvest',
    player: t.activePlayer,
    options: h.remaining.map((s) => ({ ...s, pos: { ...s.pos } })),
  };
}

/** Handle the chooseHarvest decision answer. */
export function resolveChooseHarvest(draft: GameState, player: PlayerId, sourceKey: string): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'chooseHarvest') illegal('No harvest-order decision is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s harvest, not player ${player}'s`);
  const h = draft.harvest;
  if (!h) internal('chooseHarvest without harvest state');
  if (!h.remaining.some((s) => s.key === sourceKey)) {
    badArg(`"${sourceKey}" is not an unresolved harvest source`);
  }
  draft.pendingDecision = null;
  resolveHarvestSourceByKey(draft, sourceKey);
}

// ---------------------------------------------------------------------------
// Per-source resolution
// ---------------------------------------------------------------------------

function resolveHarvestSourceByKey(draft: GameState, sourceKey: string): void {
  const t = requireTurn(draft);
  const h = draft.harvest;
  if (!h) internal('resolveHarvestSource without harvest state');
  const idx = h.remaining.findIndex((s) => s.key === sourceKey);
  if (idx < 0) internal(`Harvest source ${sourceKey} not found`);
  const source = h.remaining[idx];
  h.remaining.splice(idx, 1);
  const player = getPlayer(draft, t.activePlayer);

  if (source.kind === 'home') {
    resolveHomeSource(draft, player.id);
    return;
  }

  // Re-validate: the board may have changed since the phase began.
  const g = gardenAt(draft, source.pos);
  if (!g || g.type !== source.gardenType || !gardenIsActive(draft, g)) {
    pushEvent(draft, { type: 'harvestSkipped', sourceKey, reason: 'garden no longer present/active' });
    return;
  }
  const ownGnomes = playerUnitsAt(draft, source.pos, player.id).filter((u) => u.kind === 'gnome');
  if (ownGnomes.length === 0) {
    pushEvent(draft, { type: 'harvestSkipped', sourceKey, reason: 'no longer occupied' });
    return;
  }
  if (g.type !== 'flytrap' && enemyUnitsAt(draft, source.pos, player.id).length > 0) {
    pushEvent(draft, { type: 'harvestSkipped', sourceKey, reason: 'contested' });
    return;
  }
  if (g.skipNextHarvest) {
    delete g.skipNextHarvest;
    pushEvent(draft, { type: 'harvestSkipped', sourceKey, reason: 'Sundown Sabotage' });
    return;
  }

  switch (g.type) {
    case 'dandelion': {
      const n = Math.min(2, ownGnomes.length);
      pushEvent(draft, { type: 'dandelionHarvested', player: player.id, pos: source.pos, gnomes: n });
      gainWishes(draft, player.id, n);
      return;
    }
    case 'mushroom': {
      const max = mushroomCloneMax(draft, player.id, ownGnomes.length);
      if (max === 0) {
        pushEvent(draft, { type: 'mushroomHarvested', player: player.id, pos: source.pos, cloned: 0 });
        return;
      }
      draft.pendingDecision = { kind: 'mushroomClones', player: player.id, pos: { ...source.pos }, max };
      return;
    }
    case 'maize': {
      // The harvesting OWNER rolls (RULES.md) — Snake Eyes / 4 Leaf Clover
      // modifiers apply and are consumed, unlike the flytrap's system roll.
      const roll = rollPlayerD6(draft, player.id);
      const doubled = roll < 4;
      if (doubled) g.doubledForPlayerTurn = player.id;
      pushEvent(draft, { type: 'maizeHarvested', player: player.id, pos: source.pos, roll, doubled });
      return;
    }
    case 'slippery': {
      for (const u of ownGnomes) {
        h.moveQueue.push({ unitId: u.id, effect: 'slippery', pos: { ...source.pos } });
      }
      return;
    }
    case 'tunnel': {
      for (const u of ownGnomes) {
        h.moveQueue.push({ unitId: u.id, effect: 'tunnel', pos: { ...source.pos } });
      }
      return;
    }
    case 'flytrap': {
      if (g.stunnedForPlayerTurn !== null) {
        pushEvent(draft, { type: 'harvestSkipped', sourceKey, reason: 'flytrap stunned' });
        return;
      }
      // The flytrap attacks each occupying gnome — one fight per gnome.
      for (const u of ownGnomes) {
        queueFight(draft, {
          pos: { ...source.pos },
          sides: [
            { kind: 'player', player: player.id },
            { kind: 'flytrap' },
          ],
          targetUnit: u.id,
          pinned: null,
          cause: 'harvest',
        });
      }
      return;
    }
    case 'home':
      internal('home garden handled separately');
  }
}

function mushroomCloneMax(state: GameState, player: PlayerId, occupyingGnomes: number): number {
  const boardRoom = state.config.gnomeBoardLimit - gnomesOnBoard(state, player);
  return Math.max(0, Math.min(2, occupyingGnomes, boardRoom, reserveGnomes(state, player)));
}

function resolveHomeSource(draft: GameState, player: PlayerId): void {
  const homeGarden = gardenAt(draft, getPlayer(draft, player).homePos);
  if (homeGarden && homeGarden.skipNextHarvest) {
    delete homeGarden.skipNextHarvest;
    pushEvent(draft, { type: 'harvestSkipped', sourceKey: 'home', reason: 'Sundown Sabotage' });
    return;
  }
  const options: HomeHarvestChoice[] = ['wish'];
  if (canSpawnGnome(draft, player)) options.push('gnome');
  if (options.length === 1) {
    // Gnome unavailable ⇒ the wish is taken automatically (it may still be
    // lost to the wish cap — the reward is then lost entirely).
    applyHomeHarvest(draft, player, 'wish');
    return;
  }
  draft.pendingDecision = { kind: 'homeHarvest', player, options };
}

function applyHomeHarvest(draft: GameState, player: PlayerId, take: HomeHarvestChoice): void {
  const p = getPlayer(draft, player);
  if (take === 'gnome') {
    if (!canSpawnGnome(draft, player)) illegal('Cannot take a gnome: at a gnome limit');
    pushEvent(draft, { type: 'homeHarvested', player, took: 'gnome' });
    spawnGnome(draft, player, p.homePos);
    return;
  }
  const atCap = p.wishes >= wishCap(draft, player);
  pushEvent(draft, { type: 'homeHarvested', player, took: atCap ? 'nothing' : 'wish' });
  gainWishes(draft, player, 1);
}

// ---------------------------------------------------------------------------
// Decision answers
// ---------------------------------------------------------------------------

export function resolveHomeHarvest(draft: GameState, player: PlayerId, take: HomeHarvestChoice): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'homeHarvest') illegal('No home-harvest decision is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s decision, not player ${player}'s`);
  if (!d.options.includes(take)) illegal(`"${take}" is not a legal home-harvest choice right now`);
  draft.pendingDecision = null;
  applyHomeHarvest(draft, player, take);
}

export function resolveMushroomClones(draft: GameState, player: PlayerId, count: number): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'mushroomClones') illegal('No mushroom-clone decision is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s decision, not player ${player}'s`);
  if (!Number.isInteger(count) || count < 0 || count > d.max) {
    badArg(`Clone count must be an integer between 0 and ${d.max}`);
  }
  draft.pendingDecision = null;
  pushEvent(draft, { type: 'mushroomHarvested', player, pos: d.pos, cloned: count });
  for (let i = 0; i < count; i++) {
    if (!canSpawnGnome(draft, player)) break; // defensive; max already capped
    spawnGnome(draft, player, d.pos);
  }
}

export function resolveSlide(draft: GameState, player: PlayerId, to: Pos): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'slide') illegal('No slide decision is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s decision, not player ${player}'s`);
  if (!d.options.some((p) => samePos(p, to))) badArg(`(${to.x},${to.y}) is not a legal slide destination`);
  const unit = draft.units[d.unitId];
  if (!unit) internal('Sliding unit vanished');
  draft.pendingDecision = null;
  consumeHarvestMove(draft, d.context, d.unitId);
  const from = { ...unit.pos };
  unit.pos = { x: to.x, y: to.y };
  pushEvent(draft, { type: 'unitSlid', player, unitId: unit.id, from, to: unit.pos, context: d.context });
  handleEntry(draft, unit.id);
}

export function resolveTunnel(draft: GameState, player: PlayerId, to: Pos): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'tunnel') illegal('No tunnel decision is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s decision, not player ${player}'s`);
  if (!d.options.some((p) => samePos(p, to))) badArg(`(${to.x},${to.y}) is not a legal tunnel destination`);
  const unit = draft.units[d.unitId];
  if (!unit) internal('Tunneling unit vanished');
  draft.pendingDecision = null;
  consumeHarvestMove(draft, d.context, d.unitId);
  if (samePos(unit.pos, to)) {
    // Harvest option "any garden occupied by your own gnome" includes the
    // tunnel itself — choosing it means staying put (no re-entry).
    return;
  }
  const from = { ...unit.pos };
  unit.pos = { x: to.x, y: to.y };
  pushEvent(draft, { type: 'unitTunneled', player, unitId: unit.id, from, to: unit.pos, context: d.context });
  handleEntry(draft, unit.id);
}

export function resolveDeclineEffect(draft: GameState, player: PlayerId): void {
  const d = draft.pendingDecision;
  if (!d || (d.kind !== 'slide' && d.kind !== 'tunnel' && d.kind !== 'snailMove')) {
    illegal('No declinable effect is pending');
  }
  if (d.player !== player) illegal(`It is player ${d.player}'s decision, not player ${player}'s`);
  if (d.kind === 'snailMove') {
    // Snailmaggedon moves are optional ("snails CAN move").
    draft.pendingDecision = null;
    const h = draft.harvest;
    if (h && h.snailMoves[0] === player) h.snailMoves.shift();
    pushEvent(draft, { type: 'entryEffectDeclined', player, unitId: d.unitId, pos: d.from });
    return;
  }
  if (!d.optional) illegal('This effect is a mandatory harvest activation and cannot be declined');
  draft.pendingDecision = null;
  pushEvent(draft, { type: 'entryEffectDeclined', player, unitId: d.unitId, pos: d.from });
}

/** Snailmaggedon: move the snail 1 space during another player's Harvest Phase. */
export function resolveSnailMove(draft: GameState, player: PlayerId, to: Pos): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'snailMove') illegal('No snail-move decision is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s decision, not player ${player}'s`);
  if (!d.options.some((p) => samePos(p, to))) badArg(`(${to.x},${to.y}) is not a legal snail destination`);
  const snail = draft.units[d.unitId];
  if (!snail) internal('Snail vanished');
  draft.pendingDecision = null;
  const h = draft.harvest;
  if (h && h.snailMoves[0] === player) h.snailMoves.shift();
  const from = { ...snail.pos };
  snail.pos = { x: to.x, y: to.y };
  pushEvent(draft, { type: 'unitMoved', player, unitId: snail.id, from, to: snail.pos });
  // This is a bonus move: it does not consume the snail's own-turn movement,
  // and no end-of-turn garden destruction happens here (not the snail's turn).
  handleEntry(draft, snail.id);
}

function consumeHarvestMove(draft: GameState, context: 'entry' | 'harvest', unitId: UnitId): void {
  if (context !== 'harvest') return;
  const h = draft.harvest;
  if (!h || h.moveQueue.length === 0) return;
  if (h.moveQueue[0].unitId === unitId) h.moveQueue.shift();
}

// ---------------------------------------------------------------------------
// Small shared query used by engine.getLegalActions
// ---------------------------------------------------------------------------

/** Is `pos` an empty space (no garden, no enemy critters) plantable by `player`? */
export function canPlantAt(state: GameState, player: PlayerId, pos: Pos): boolean {
  if (gardenAt(state, pos) !== null) return false;
  if (enemyUnitsAt(state, pos, player).length > 0) return false;
  const own = playerUnitsAt(state, pos, player);
  return own.some((u) => u.kind === 'gnome');
}

/** Ensure a garden object literal is well-formed. */
export function makeGarden(type: Garden['type'], plantedOnTurn: number, owner?: PlayerId): Garden {
  const g: Garden = {
    type,
    plantedOnTurn,
    stunnedForPlayerTurn: null,
    doubledForPlayerTurn: null,
  };
  if (owner !== undefined) g.owner = owner;
  return g;
}

/** All units on the board (used by AI / UI helpers). */
export function allUnits(state: GameState): Unit[] {
  const out = Object.values(state.units);
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
