/**
 * Data-driven Whimsy Card system — the official list from CARDS.md.
 *
 * Deck: 2 copies of each of the 23 Whimsy cards (10 Sudden + 13 Ritual) =
 * 46 cards, plus 5 Curse cards that join the deck one-per-reshuffle.
 *
 * PLAY / RESPONSE MODEL (CARDS.md "Timing framework"):
 *  - Playing a card moves it hand → discard immediately (a cancelled card
 *    still ends up in the discard) and pushes an entry onto `state.cardStack`.
 *  - Before a played card resolves, every OTHER player with status 'playing'
 *    (clockwise from the card's player) gets a response window to play Sudden
 *    Magic (`cardResponse` decision; auto-passed when they have nothing
 *    playable). Nope-Gnome is playable ONLY in these windows and cancels the
 *    card it responds to.
 *  - The stack resolves LIFO. After each resolution the new top card gets a
 *    fresh response round (it has not resolved yet), unless it is cancelled.
 *  - Targets are chosen when the card is PLAYED and validated then; they are
 *    re-validated at resolution — a card whose targets became invalid fizzles
 *    (logged, no effect).
 *
 * Effects use the shared draft mutators; free moves granted by cards do not
 * consume the unit's movement action, but Entry triggers, maize exit costs,
 * Great Wall and Lost In The Maize apply as specified per card.
 */

import type {
  CardId,
  CardStackEntry,
  CardTarget,
  CardTargets,
  GameState,
  PlantableGardenType,
  PlayerId,
  Pos,
  TargetKind,
  Unit,
} from './types';
import {
  badArg,
  canSpawnGnome,
  destroyGarden,
  destroyUnit,
  draftInt,
  draftShuffle,
  enforceHandLimit,
  enemyUnitsAt,
  entryBlockedByWall,
  gainWishes,
  gardenAt,
  gardenIsActive,
  getPlayer,
  gnomeExitBlocked,
  inBounds,
  maizeExitCost,
  orthNeighbors,
  otherPlayingPlayers,
  playerUnits,
  posKey,
  pushEvent,
  requireTurn,
  samePos,
  spawnGnome,
  spendWishes,
  unitsAt,
} from './helpers';
import { queueFight } from './fights';
import { handleEntry, makeGarden } from './gardens';

// ---------------------------------------------------------------------------
// Definition types
// ---------------------------------------------------------------------------

export type CardTiming = 'sudden' | 'ritual';

/**
 * Phased targeting. Instead of describing slots and letting the engine expand
 * every complete `CardTargets` payload up front, a targeted card declares an
 * ORDERED FLOW of steps. The engine surfaces one step at a time (a
 * `cardTargeting` decision); each step computes its own legal options from the
 * live state AND the targets already chosen in earlier steps, so later choices
 * can be narrowed by earlier ones (Plot Twist: pick a space, then only its
 * orthogonal neighbours are offered). This keeps the cost proportional to the
 * current decision step, not the product of every slot.
 *
 * The card's own `validate` remains the final authority: it re-runs on the
 * complete payload before the card is committed, so a step author never has to
 * be perfectly exhaustive for correctness — only honest enough that every
 * option it returns can lead to at least one valid completion (which keeps the
 * UI/AI from ever offering a dead-end pick).
 */
export interface TargetingContext {
  player: PlayerId;
  /** Targets chosen in earlier steps (read to narrow this step). */
  selected: CardTargets;
}

export interface TargetStep {
  /** Which `CardTargets` field this step fills. */
  kind: TargetKind;
  /** Prompt shown while this step awaits a pick ("Choose the first garden"). */
  prompt: string;
  /**
   * Whether pick order matters relative to OTHER steps of the same kind. Only
   * the complete-enumeration analysis helper reads it, to keep one canonical
   * order for symmetric multi-picks (Gnomio & Juliet) while emitting both
   * orders for genuinely ordered ones (Instigation: attacker then defender).
   * Phased play never duplicates — the player makes one sequence of picks.
   */
  ordered?: boolean;
  /** Legal options for THIS step, given the state and the earlier picks. */
  getOptions: (state: GameState, ctx: TargetingContext) => CardTarget[];
}

export interface WhimsyCardDef {
  id: CardId;
  name: string;
  text: string;
  timing: CardTiming;
  /** Copies in the deck (designer confirmed: 2 each). */
  copies: number;
  /** Playable only inside a cardResponse window (Nope-Gnome today). */
  respondOnly?: boolean;
  /**
   * The card acts on the card it is responding to, rather than on targets the
   * player picks. When played inside a cardResponse window the router records
   * the responded-to stack index on the entry (`respondsToStackIndex`), which
   * the card's `resolve` reads. This is what makes response routing generic:
   * a second counter-card only needs this flag, not a change to the router.
   */
  targetsRespondedCard?: boolean;
  /** Does this card require a `targets` payload? (⟺ `targetFlow` is present.) */
  needsTargets: boolean;
  /**
   * The ordered targeting flow, built from the live state (so a card can size
   * itself — Pocket Shovel plants as many tunnels as remain). Absent for
   * untargeted cards. See `TargetStep`.
   */
  targetFlow?: (state: GameState, player: PlayerId) => TargetStep[];
  /** Cheap existence check: could this card be played at all right now? */
  hasAnyPlay?: (state: GameState, player: PlayerId) => boolean;
  /**
   * Validate the chosen targets. Returns an error string or null. Called at
   * play time (errors throw) and again at resolution (errors fizzle).
   */
  validate?: (state: GameState, player: PlayerId, targets: CardTargets | undefined) => string | null;
  /** Apply the effect. Targets have passed `validate` at resolution time. */
  resolve: (draft: GameState, entry: CardStackEntry) => void;
}

export interface CurseCardDef {
  id: CardId;
  name: string;
  text: string;
  /** Optional hook run once when revealed (all 5 curses are passive flags). */
  onReveal?: (draft: GameState) => void;
}

// ---------------------------------------------------------------------------
// Shared validation / effect helpers
// ---------------------------------------------------------------------------

function targetUnit(state: GameState, targets: CardTargets | undefined, idx: number): Unit | null {
  const id = targets?.units?.[idx];
  if (id === undefined) return null;
  return state.units[id] ?? null;
}

function targetSpace(targets: CardTargets | undefined, idx: number): Pos | null {
  return targets?.spaces?.[idx] ?? null;
}

/** Empty space per Wild Growth's ruling: no garden, no critters at all. */
function isEmptySpace(state: GameState, pos: Pos): boolean {
  return gardenAt(state, pos) === null && unitsAt(state, pos).length === 0;
}

/** Enemy critters (units or an active un-stunned flytrap) block pass-through. */
function hasBlockingCritter(state: GameState, pos: Pos, mover: PlayerId): boolean {
  if (enemyUnitsAt(state, pos, mover).length > 0) return true;
  const g = gardenAt(state, pos);
  return !!g && g.type === 'flytrap' && gardenIsActive(state, g) && g.stunnedForPlayerTurn === null;
}

/**
 * Validate a card-granted move of `unit` leaving its current space:
 * Lost In The Maize lock and the maize exit cost (paid by the unit's OWNER).
 * Returns an error string or null. `extraCostFrom` adds a second traversed
 * space's exit cost (Slippery Trail).
 */
function validateCardExit(state: GameState, unit: Unit, extraCostFrom: Pos | null): string | null {
  const locked = gnomeExitBlocked(state, unit);
  if (locked) return locked;
  let cost = maizeExitCost(state, unit.pos);
  if (extraCostFrom) cost += maizeExitCost(state, extraCostFrom);
  const owner = getPlayer(state, unit.owner);
  if (owner.wishes < cost) {
    return `${owner.name} cannot pay the ${cost}-Wish maize exit cost`;
  }
  return null;
}

/** Pay maize exit costs for a card-granted move, then move + Entry triggers. */
function executeCardMove(
  draft: GameState,
  entry: CardStackEntry,
  unit: Unit,
  to: Pos,
  extraCostFrom: Pos | null,
): void {
  let cost = maizeExitCost(draft, unit.pos);
  const from = { ...unit.pos };
  if (extraCostFrom) cost += maizeExitCost(draft, extraCostFrom);
  if (cost > 0) {
    spendWishes(draft, unit.owner, cost, 'maize exit (card move)');
    pushEvent(draft, { type: 'maizeExitPaid', player: unit.owner, pos: from, cost });
  }
  unit.pos = { x: to.x, y: to.y };
  pushEvent(draft, {
    type: 'unitTeleported',
    player: unit.owner,
    unitId: unit.id,
    from,
    to: unit.pos,
    cardId: entry.cardId,
  });
  handleEntry(draft, unit.id);
}

function fizzle(draft: GameState, entry: CardStackEntry, reason: string): void {
  pushEvent(draft, { type: 'cardFizzled', player: entry.player, cardId: entry.cardId, reason });
}

function anyGnome(state: GameState): boolean {
  return Object.values(state.units).some((u) => u.kind === 'gnome');
}

function anyOwnGnome(state: GameState, player: PlayerId): boolean {
  return playerUnits(state, player).some((u) => u.kind === 'gnome');
}

function anyEmptySpace(state: GameState): boolean {
  const n = state.config.boardSize;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (isEmptySpace(state, { x, y })) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Targeting-flow helpers
//
// Small constructors that turn a card-authored "which values are legal for
// this step" function into a `TargetStep`. They keep the option order
// deterministic (sorted unit ids, row-major spaces, seat order) so seeded
// replays are stable, and map raw values into the serializable `CardTarget`
// shape the engine surfaces. Cards compose these; none of them, nor the engine
// that runs them, ever branches on a card id.
// ---------------------------------------------------------------------------

const DIAGONAL_OFFSETS: Pos[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
];
const STRAIGHT_TWO_OFFSETS: Pos[] = [
  { x: 0, y: -2 },
  { x: 2, y: 0 },
  { x: 0, y: 2 },
  { x: -2, y: 0 },
];

function allBoardSpaces(state: GameState): Pos[] {
  const n = state.config.boardSize;
  const out: Pos[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) out.push({ x, y });
  }
  return out;
}

function allGnomes(state: GameState): Unit[] {
  return Object.values(state.units).filter((u) => u.kind === 'gnome');
}

function ownGnomeList(state: GameState, player: PlayerId): Unit[] {
  return playerUnits(state, player).filter((u) => u.kind === 'gnome');
}

/** Board spaces holding a non-Home garden, row-major. */
function nonHomeGardenSpaces(state: GameState): Pos[] {
  return allBoardSpaces(state).filter((p) => {
    const g = gardenAt(state, p);
    return !!g && g.type !== 'home';
  });
}

/** Board spaces holding any garden, row-major. */
function anyGardenSpaces(state: GameState): Pos[] {
  return allBoardSpaces(state).filter((p) => gardenAt(state, p) !== null);
}

/** The unit chosen in an earlier step (or undefined if it has since vanished). */
function pickedUnit(state: GameState, ctx: TargetingContext, i: number): Unit | undefined {
  const id = ctx.selected.units?.[i];
  return id === undefined ? undefined : state.units[id];
}

function pickedSpace(ctx: TargetingContext, i: number): Pos | undefined {
  return ctx.selected.spaces?.[i];
}

function unitStep(
  prompt: string,
  pick: (state: GameState, ctx: TargetingContext) => Unit[],
  ordered = false,
): TargetStep {
  return {
    kind: 'unit',
    prompt,
    ordered,
    getOptions: (s, ctx) =>
      [...pick(s, ctx)]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((u) => ({ kind: 'unit', unitId: u.id })),
  };
}

function spaceStep(
  prompt: string,
  pick: (state: GameState, ctx: TargetingContext) => Pos[],
  ordered = false,
): TargetStep {
  return {
    kind: 'space',
    prompt,
    ordered,
    getOptions: (s, ctx) => pick(s, ctx).map((p) => ({ kind: 'space', pos: { x: p.x, y: p.y } })),
  };
}

function playerStep(
  prompt: string,
  pick: (state: GameState, ctx: TargetingContext) => PlayerId[],
): TargetStep {
  return {
    kind: 'player',
    prompt,
    getOptions: (s, ctx) => pick(s, ctx).map((id) => ({ kind: 'player', playerId: id })),
  };
}

function cardZoneStep(
  prompt: string,
  pick: (state: GameState, ctx: TargetingContext) => CardId[],
): TargetStep {
  return {
    kind: 'card',
    prompt,
    getOptions: (s, ctx) => pick(s, ctx).map((cardId) => ({ kind: 'card', cardId })),
  };
}

function gardenTypeStep(
  prompt: string,
  pick: (state: GameState, ctx: TargetingContext) => PlantableGardenType[],
): TargetStep {
  return {
    kind: 'gardenType',
    prompt,
    getOptions: (s, ctx) => pick(s, ctx).map((gardenType) => ({ kind: 'gardenType', gardenType })),
  };
}

/** Diagonally adjacent, on-board, non-walled destinations for a card move. */
function diagonalDests(state: GameState, unit: Unit): Pos[] {
  return DIAGONAL_OFFSETS.map((d) => ({ x: unit.pos.x + d.x, y: unit.pos.y + d.y })).filter(
    (q) => inBounds(state, q) && !entryBlockedByWall(state, q),
  );
}

/** Orthogonally adjacent, on-board, non-walled destinations for a card move. */
function orthDests(state: GameState, unit: Unit): Pos[] {
  return orthNeighbors(state, unit.pos).filter((q) => !entryBlockedByWall(state, q));
}

/** Straight-two destinations for Slippery Trail (mirrors its `validate`). */
function straightTwoDests(state: GameState, unit: Unit): Pos[] {
  const out: Pos[] = [];
  for (const d of STRAIGHT_TWO_OFFSETS) {
    const to = { x: unit.pos.x + d.x, y: unit.pos.y + d.y };
    if (!inBounds(state, to)) continue;
    const mid = { x: unit.pos.x + d.x / 2, y: unit.pos.y + d.y / 2 };
    if (hasBlockingCritter(state, mid, unit.owner)) continue;
    if (entryBlockedByWall(state, mid) || entryBlockedByWall(state, to)) continue;
    const midG = gardenAt(state, mid);
    if (midG && midG.type === 'maize' && gardenIsActive(state, midG) && gnomeExitBlocked(state, { ...unit, pos: mid })) {
      continue;
    }
    if (validateCardExit(state, unit, mid) !== null) continue;
    out.push(to);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sudden Magic (10)
// ---------------------------------------------------------------------------

const hiddenPassage: WhimsyCardDef = {
  id: 'hidden-passage',
  name: 'Hidden Passage',
  text: 'Move a gnome you control 1 space diagonally.',
  timing: 'sudden',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [
    unitStep(
      'Choose a gnome you control to move diagonally',
      (s, ctx) =>
        ownGnomeList(s, ctx.player).filter(
          (u) => validateCardExit(s, u, null) === null && diagonalDests(s, u).length > 0,
        ),
    ),
    spaceStep('Choose the diagonal destination', (s, ctx) => {
      const u = pickedUnit(s, ctx, 0);
      return u ? diagonalDests(s, u) : [];
    }),
  ],
  hasAnyPlay: (s, p) => anyOwnGnome(s, p),
  validate: (s, p, t) => {
    const u = targetUnit(s, t, 0);
    const to = targetSpace(t, 0);
    if (!u || u.kind !== 'gnome') return 'target must be a gnome';
    if (u.owner !== p) return 'target gnome must be one you control';
    if (!to || !inBounds(s, to)) return 'destination is off the board';
    if (Math.abs(to.x - u.pos.x) !== 1 || Math.abs(to.y - u.pos.y) !== 1) {
      return 'destination must be diagonally adjacent';
    }
    if (entryBlockedByWall(s, to)) return 'the Great Wall Of Whimsy blocks that space';
    return validateCardExit(s, u, null);
  },
  resolve: (d, e) => {
    const u = targetUnit(d, e.targets, 0);
    const to = targetSpace(e.targets, 0);
    if (!u || !to) return fizzle(d, e, 'target vanished');
    executeCardMove(d, e, u, to, null);
  },
};

const snakeEyes: WhimsyCardDef = {
  id: 'snake-eyes',
  name: 'Snake Eyes',
  text: 'Target player subtracts 2 from their next dice roll.',
  timing: 'sudden',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [playerStep('Choose any player', (s) => s.players.map((p) => p.id))],
  validate: (s, _p, t) => {
    const target = t?.players?.[0];
    if (target === undefined || !s.players[target]) return 'target must be a player';
    return null;
  },
  resolve: (d, e) => {
    const target = e.targets?.players?.[0] as PlayerId;
    d.rollModifiers[target] = (d.rollModifiers[target] ?? 0) - 2;
  },
};

const slipperyTrail: WhimsyCardDef = {
  id: 'slippery-trail',
  name: 'Slippery Trail',
  text: 'Move a gnome you control 2 spaces in a straight line.',
  timing: 'sudden',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [
    unitStep(
      'Choose a gnome you control to slide 2 spaces',
      (s, ctx) => ownGnomeList(s, ctx.player).filter((u) => straightTwoDests(s, u).length > 0),
    ),
    spaceStep('Choose the straight-line destination', (s, ctx) => {
      const u = pickedUnit(s, ctx, 0);
      return u ? straightTwoDests(s, u) : [];
    }),
  ],
  hasAnyPlay: (s, p) => anyOwnGnome(s, p),
  validate: (s, p, t) => {
    const u = targetUnit(s, t, 0);
    const to = targetSpace(t, 0);
    if (!u || u.kind !== 'gnome') return 'target must be a gnome';
    if (u.owner !== p) return 'target gnome must be one you control';
    if (!to || !inBounds(s, to)) return 'destination is off the board';
    const dx = to.x - u.pos.x;
    const dy = to.y - u.pos.y;
    if (!((Math.abs(dx) === 2 && dy === 0) || (Math.abs(dy) === 2 && dx === 0))) {
      return 'destination must be exactly 2 spaces away in a straight orthogonal line';
    }
    const mid = { x: u.pos.x + dx / 2, y: u.pos.y + dy / 2 };
    if (hasBlockingCritter(s, mid, u.owner)) return 'an enemy critter blocks the intermediate space';
    if (entryBlockedByWall(s, mid)) return 'the Great Wall Of Whimsy blocks the intermediate space';
    if (entryBlockedByWall(s, to)) return 'the Great Wall Of Whimsy blocks the destination';
    const midG = gardenAt(s, mid);
    if (midG && midG.type === 'maize' && gardenIsActive(s, midG) && gnomeExitBlocked(s, { ...u, pos: mid })) {
      return 'Lost In The Maize: the gnome could not leave the intermediate Maize Garden';
    }
    return validateCardExit(s, u, mid);
  },
  resolve: (d, e) => {
    const u = targetUnit(d, e.targets, 0);
    const to = targetSpace(e.targets, 0);
    if (!u || !to) return fizzle(d, e, 'target vanished');
    const mid = { x: (u.pos.x + to.x) / 2, y: (u.pos.y + to.y) / 2 };
    executeCardMove(d, e, u, to, mid);
  },
};

const fourLeafClover: WhimsyCardDef = {
  id: 'four-leaf-clover',
  name: '4 Leaf Clover',
  text: 'Add 3 to your next dice roll.',
  timing: 'sudden',
  copies: 2,
  needsTargets: false,
  resolve: (d, e) => {
    d.rollModifiers[e.player] = (d.rollModifiers[e.player] ?? 0) + 3;
  },
};

const gustOfWind: WhimsyCardDef = {
  id: 'gust-of-wind',
  name: 'Gust Of Wind',
  text: 'Move any gnome 1 space (orthogonal).',
  timing: 'sudden',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [
    unitStep(
      'Choose any gnome to move 1 space',
      (s) => allGnomes(s).filter((u) => validateCardExit(s, u, null) === null && orthDests(s, u).length > 0),
    ),
    spaceStep('Choose the orthogonal destination', (s, ctx) => {
      const u = pickedUnit(s, ctx, 0);
      return u ? orthDests(s, u) : [];
    }),
  ],
  hasAnyPlay: (s) => anyGnome(s),
  validate: (s, _p, t) => {
    const u = targetUnit(s, t, 0);
    const to = targetSpace(t, 0);
    if (!u || u.kind !== 'gnome') return 'target must be a gnome';
    if (!to || !inBounds(s, to)) return 'destination is off the board';
    if (Math.abs(to.x - u.pos.x) + Math.abs(to.y - u.pos.y) !== 1) {
      return 'destination must be orthogonally adjacent';
    }
    if (entryBlockedByWall(s, to)) return 'the Great Wall Of Whimsy blocks that space';
    return validateCardExit(s, u, null); // the gnome's OWNER pays any maize exit
  },
  resolve: (d, e) => {
    const u = targetUnit(d, e.targets, 0);
    const to = targetSpace(e.targets, 0);
    if (!u || !to) return fizzle(d, e, 'target vanished');
    executeCardMove(d, e, u, to, null);
  },
};

const gnomebodyDies: WhimsyCardDef = {
  id: 'gnomebody-dies',
  name: 'Gnomebody Dies',
  text: "If a gnome would be destroyed this turn, it isn't.",
  timing: 'sudden',
  copies: 2,
  needsTargets: false,
  resolve: (d) => {
    d.preventionShields += 1;
  },
};

const nopeGnome: WhimsyCardDef = {
  id: 'nope-gnome',
  name: 'Nope-Gnome',
  text: 'Cancel the effects of a Whimsy card as it is played.',
  timing: 'sudden',
  copies: 2,
  respondOnly: true,
  targetsRespondedCard: true,
  needsTargets: false, // its target is implicit: the card it responds to
  resolve: (d, e) => {
    const idx = e.respondsToStackIndex;
    if (idx === undefined || idx < 0 || idx >= d.cardStack.length) {
      return fizzle(d, e, 'the countered card already left the stack');
    }
    const victim = d.cardStack[idx];
    if (victim.cancelled) return fizzle(d, e, 'the countered card is already cancelled');
    victim.cancelled = true;
    pushEvent(d, { type: 'cardCancelled', player: victim.player, cardId: victim.cardId });
  },
};

const gnomeBirthdayParty: WhimsyCardDef = {
  id: 'gnome-birthday-party',
  name: 'Gnome Birthday Party',
  text: 'Gain 2 Wishes.',
  timing: 'sudden',
  copies: 2,
  needsTargets: false,
  resolve: (d, e) => {
    gainWishes(d, e.player, 2); // wish cap applies; excess lost
  },
};

const gnomePlaceLikeHome: WhimsyCardDef = {
  id: 'gnome-place-like-home',
  name: 'Gnome Place Like Home',
  text: 'Target gnome goes back to their Home Garden.',
  timing: 'sudden',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [
    unitStep('Choose any gnome to send home', (s) =>
      allGnomes(s).filter((u) => {
        const home = gardenAt(s, s.players[u.owner].homePos);
        return !!home && home.type === 'home' && home.owner === u.owner && validateCardExit(s, u, null) === null;
      }),
    ),
  ],
  hasAnyPlay: (s) =>
    Object.values(s.units).some((u) => {
      if (u.kind !== 'gnome') return false;
      const home = gardenAt(s, s.players[u.owner].homePos);
      return !!home && home.type === 'home' && home.owner === u.owner;
    }),
  validate: (s, _p, t) => {
    const u = targetUnit(s, t, 0);
    if (!u || u.kind !== 'gnome') return 'target must be a gnome';
    const homePos = s.players[u.owner].homePos;
    const home = gardenAt(s, homePos);
    if (!home || home.type !== 'home' || home.owner !== u.owner) {
      return "the gnome's owner no longer has a Home Garden";
    }
    return validateCardExit(s, u, null);
  },
  resolve: (d, e) => {
    const u = targetUnit(d, e.targets, 0);
    if (!u) return fizzle(d, e, 'target vanished');
    const homePos = d.players[u.owner].homePos;
    // Arrival at their own home is not an enemy Entry; handleEntry only
    // queues fights vs enemies standing there (normal co-location).
    executeCardMove(d, e, u, homePos, null);
  },
};

const rocketPropelledGnome: WhimsyCardDef = {
  id: 'rocket-propelled-gnome',
  name: 'Rocket Propelled Gnome',
  text: 'Target gnome is destroyed.',
  timing: 'sudden',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [unitStep('Choose any gnome to destroy', (s) => allGnomes(s))],
  hasAnyPlay: (s) => anyGnome(s),
  validate: (s, _p, t) => {
    const u = targetUnit(s, t, 0);
    if (!u || u.kind !== 'gnome') return 'target must be a gnome';
    return null;
  },
  resolve: (d, e) => {
    const u = targetUnit(d, e.targets, 0);
    if (!u) return fizzle(d, e, 'target vanished');
    destroyUnit(d, u.id, 'rocket-propelled-gnome');
  },
};

// ---------------------------------------------------------------------------
// Ritual Magic (13)
// ---------------------------------------------------------------------------

const wildGrowth: WhimsyCardDef = {
  id: 'wild-growth',
  name: 'Wild Growth',
  text: 'Plant any garden on any empty space (free, no gnome required).',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [
    spaceStep('Choose an empty space', (s) => allBoardSpaces(s).filter((p) => isEmptySpace(s, p))),
    gardenTypeStep(
      'Choose a garden type to plant',
      (s) => (Object.keys(s.supply) as PlantableGardenType[]).filter((gt) => s.supply[gt] > 0),
    ),
  ],
  hasAnyPlay: (s) => anyEmptySpace(s) && Object.values(s.supply).some((n) => n > 0),
  validate: (s, _p, t) => {
    const pos = targetSpace(t, 0);
    const gt = t?.gardenType;
    if (!pos || !inBounds(s, pos)) return 'space is off the board';
    if (!isEmptySpace(s, pos)) return 'space must be empty (no garden, no critters)';
    if (!gt || !(gt in s.supply)) return 'choose a plantable garden type';
    if (s.supply[gt] <= 0) return `the shared supply has no ${gt} tiles left`;
    return null;
  },
  resolve: (d, e) => {
    const pos = targetSpace(e.targets, 0) as Pos;
    const gt = e.targets?.gardenType as PlantableGardenType;
    d.supply[gt] -= 1;
    d.gardens[posKey(pos)] = makeGarden(gt, requireTurn(d).number);
    pushEvent(d, { type: 'gardenPlanted', player: e.player, pos: { ...pos }, gardenType: gt });
  },
};

const instigation: WhimsyCardDef = {
  id: 'instigation',
  name: 'Instigation',
  text: '2 target gnomes fight.',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  // Ordered: the first gnome chosen is the attacker, so [a,b] and [b,a] are
  // genuinely different plays. Step 2 is narrowed to gnomes of a different owner.
  targetFlow: () => [
    unitStep('Choose the attacking gnome', (s) => allGnomes(s), true),
    unitStep(
      'Choose the defending gnome (different owner)',
      (s, ctx) => {
        const a = pickedUnit(s, ctx, 0);
        return a ? allGnomes(s).filter((u) => u.id !== a.id && u.owner !== a.owner) : [];
      },
      true,
    ),
  ],
  hasAnyPlay: (s) => {
    const owners = new Set(
      Object.values(s.units)
        .filter((u) => u.kind === 'gnome')
        .map((u) => u.owner),
    );
    return owners.size >= 2;
  },
  validate: (s, _p, t) => {
    const attacker = targetUnit(s, t, 0);
    const defender = targetUnit(s, t, 1);
    if (!attacker || !defender || attacker.kind !== 'gnome' || defender.kind !== 'gnome') {
      return 'both targets must be gnomes';
    }
    if (attacker.id === defender.id) return 'targets must be two different gnomes';
    if (attacker.owner === defender.owner) return 'the gnomes must have different owners';
    return null;
  },
  resolve: (d, e) => {
    const attacker = targetUnit(d, e.targets, 0) as Unit;
    const defender = targetUnit(d, e.targets, 1) as Unit;
    queueFight(d, {
      pos: { ...attacker.pos },
      sides: [
        { kind: 'player', player: defender.owner },
        { kind: 'player', player: attacker.owner },
      ],
      targetUnit: null,
      pinned: [defender.id, attacker.id], // they fight without moving
      cause: 'card',
    });
  },
};

const lawnmowerOfDoom: WhimsyCardDef = {
  id: 'lawnmower-of-doom',
  name: 'Lawnmower Of Doom',
  text: 'Destroy a non-Home garden orthogonally adjacent to a gnome you control.',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [
    spaceStep('Choose a non-Home garden next to your gnome', (s, ctx) =>
      allBoardSpaces(s).filter((pos) => {
        const g = gardenAt(s, pos);
        if (!g || g.type === 'home') return false;
        return ownGnomeList(s, ctx.player).some((u) => Math.abs(u.pos.x - pos.x) + Math.abs(u.pos.y - pos.y) === 1);
      }),
    ),
  ],
  hasAnyPlay: (s, p) =>
    playerUnits(s, p).some(
      (u) =>
        u.kind === 'gnome' &&
        [
          { x: 0, y: -1 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: -1, y: 0 },
        ].some((dxy) => {
          const q = { x: u.pos.x + dxy.x, y: u.pos.y + dxy.y };
          const g = gardenAt(s, q);
          return !!g && g.type !== 'home';
        }),
    ),
  validate: (s, p, t) => {
    const pos = targetSpace(t, 0);
    if (!pos || !inBounds(s, pos)) return 'space is off the board';
    const g = gardenAt(s, pos);
    if (!g) return 'there is no garden on that space';
    if (g.type === 'home') return 'Home Gardens cannot be destroyed by Lawnmower Of Doom';
    const adjacent = playerUnits(s, p).some(
      (u) => u.kind === 'gnome' && Math.abs(u.pos.x - pos.x) + Math.abs(u.pos.y - pos.y) === 1,
    );
    if (!adjacent) return 'the garden must be orthogonally adjacent to a gnome you control';
    return null;
  },
  resolve: (d, e) => {
    const pos = targetSpace(e.targets, 0) as Pos;
    destroyGarden(d, pos, 'card');
  },
};

const plotTwist: WhimsyCardDef = {
  id: 'plot-twist',
  name: 'Plot Twist',
  text: 'Swap the contents of two adjacent spaces (gardens and critters together).',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  // Unordered pair: selecting the first space narrows the second step to that
  // space's orthogonal neighbours (≤4), instead of every board-wide pairing.
  targetFlow: () => [
    spaceStep('Choose the first space to swap', (s) => allBoardSpaces(s)),
    spaceStep('Choose an adjacent space to swap with', (s, ctx) => {
      const a = pickedSpace(ctx, 0);
      return a ? orthNeighbors(s, a) : [];
    }),
  ],
  validate: (s, _p, t) => {
    const a = targetSpace(t, 0);
    const b = targetSpace(t, 1);
    if (!a || !b || !inBounds(s, a) || !inBounds(s, b)) return 'both spaces must be on the board';
    if (samePos(a, b)) return 'choose two different spaces';
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return 'spaces must be orthogonally adjacent';
    return null;
  },
  resolve: (d, e) => {
    const a = targetSpace(e.targets, 0) as Pos;
    const b = targetSpace(e.targets, 1) as Pos;
    const ka = posKey(a);
    const kb = posKey(b);
    // Swap gardens.
    const ga = d.gardens[ka];
    const gb = d.gardens[kb];
    if (ga) d.gardens[kb] = ga;
    else delete d.gardens[kb];
    if (gb) d.gardens[ka] = gb;
    else delete d.gardens[ka];
    // Home Garden anchors follow their garden.
    for (const p of d.players) {
      if (samePos(p.homePos, a) && ga?.type === 'home' && ga.owner === p.id) p.homePos = { ...b };
      else if (samePos(p.homePos, b) && gb?.type === 'home' && gb.owner === p.id) p.homePos = { ...a };
    }
    // Great Wall markers follow their garden.
    for (const eff of d.timedEffects) {
      if (eff.kind !== 'greatWall' || !eff.pos) continue;
      if (samePos(eff.pos, a)) eff.pos = { ...b };
      else if (samePos(eff.pos, b)) eff.pos = { ...a };
    }
    // Swap critters (no Entry triggers).
    for (const u of Object.values(d.units)) {
      if (samePos(u.pos, a)) u.pos = { ...b };
      else if (samePos(u.pos, b)) u.pos = { ...a };
    }
    pushEvent(d, { type: 'spacesSwapped', a: { ...a }, b: { ...b } });
    // Defensive: if the swap somehow co-located enemies, fights trigger.
    for (const pos of [a, b]) {
      const owners = [...new Set(unitsAt(d, pos).map((u) => u.owner))].sort((x, y) => x - y);
      if (owners.length >= 2) {
        queueFight(d, {
          pos: { ...pos },
          sides: [
            { kind: 'player', player: owners[0] },
            { kind: 'player', player: owners[1] },
          ],
          targetUnit: null,
          pinned: null,
          cause: 'card',
        });
      }
    }
  },
};

const greatWallOfWhimsy: WhimsyCardDef = {
  id: 'great-wall-of-whimsy',
  name: 'Great Wall Of Whimsy',
  text: 'Until your next turn, units cannot enter target non-Home Garden.',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [spaceStep('Choose a non-Home garden to wall', (s) => nonHomeGardenSpaces(s))],
  hasAnyPlay: (s) => Object.values(s.gardens).some((g) => g.type !== 'home'),
  validate: (s, _p, t) => {
    const pos = targetSpace(t, 0);
    if (!pos || !inBounds(s, pos)) return 'space is off the board';
    const g = gardenAt(s, pos);
    if (!g) return 'there is no garden on that space';
    if (g.type === 'home') return 'Home Gardens cannot be walled';
    return null;
  },
  resolve: (d, e) => {
    const pos = targetSpace(e.targets, 0) as Pos;
    d.timedEffects.push({ kind: 'greatWall', caster: e.player, pos: { ...pos } });
    pushEvent(d, { type: 'timedEffectStarted', kind: 'greatWall', player: e.player, pos: { ...pos } });
  },
};

const sundownSabotage: WhimsyCardDef = {
  id: 'sundown-sabotage',
  name: 'Sundown Sabotage',
  text: 'Target garden skips its next harvest.',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [spaceStep('Choose any garden', (s) => anyGardenSpaces(s))],
  hasAnyPlay: (s) => Object.values(s.gardens).length > 0,
  validate: (s, _p, t) => {
    const pos = targetSpace(t, 0);
    if (!pos || !inBounds(s, pos)) return 'space is off the board';
    if (!gardenAt(s, pos)) return 'there is no garden on that space';
    return null;
  },
  resolve: (d, e) => {
    const pos = targetSpace(e.targets, 0) as Pos;
    const g = gardenAt(d, pos);
    if (!g) return fizzle(d, e, 'the garden vanished');
    g.skipNextHarvest = true;
  },
};

const ritualMagic: WhimsyCardDef = {
  id: 'ritual-magic',
  name: 'Ritual Magic',
  text: "Steal a random Whimsy card from target player's hand.",
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [
    playerStep('Choose a player to steal from', (s, ctx) =>
      s.players.filter((pl) => pl.id !== ctx.player && pl.hand.length > 0).map((pl) => pl.id),
    ),
  ],
  hasAnyPlay: (s, p) => s.players.some((pl) => pl.id !== p && pl.hand.length > 0),
  validate: (s, p, t) => {
    const target = t?.players?.[0];
    if (target === undefined || !s.players[target]) return 'target must be a player';
    if (target === p) return 'target must be another player';
    if (s.players[target].hand.length === 0) return 'target has no cards in hand';
    return null;
  },
  resolve: (d, e) => {
    const target = e.targets?.players?.[0] as PlayerId;
    const hand = d.players[target].hand;
    if (hand.length === 0) return fizzle(d, e, 'target has no cards left');
    const idx = draftInt(d, hand.length);
    const stolen = hand.splice(idx, 1)[0];
    d.players[e.player].hand.push(stolen);
    pushEvent(d, { type: 'cardStolen', from: target, to: e.player, cardId: stolen });
    enforceHandLimit(d, e.player);
  },
};

const seeingDouble: WhimsyCardDef = {
  id: 'seeing-double',
  name: 'Seeing Double',
  text: 'Clone target gnome (the clone belongs to its owner).',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [unitStep('Choose any gnome to clone', (s) => allGnomes(s))],
  hasAnyPlay: (s) => anyGnome(s),
  validate: (s, _p, t) => {
    const u = targetUnit(s, t, 0);
    if (!u || u.kind !== 'gnome') return 'target must be a gnome';
    return null;
  },
  resolve: (d, e) => {
    const u = targetUnit(d, e.targets, 0);
    if (!u) return fizzle(d, e, 'target vanished');
    if (!canSpawnGnome(d, u.owner)) {
      return fizzle(d, e, "the target's owner is at a gnome limit");
    }
    spawnGnome(d, u.owner, u.pos); // may move normally on its owner's turn
  },
};

const gnomioAndJuliet: WhimsyCardDef = {
  id: 'gnomio-and-juliet',
  name: 'Gnomio & Juliet',
  text: 'Marry 2 gnomes; when a married gnome dies, its partner is destroyed as well.',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  // Unordered pair (marriage is symmetric); step 2 excludes the first gnome.
  targetFlow: () => [
    unitStep('Choose the first gnome to marry', (s) => allGnomes(s)),
    unitStep('Choose the second gnome to marry', (s, ctx) => {
      const a = pickedUnit(s, ctx, 0);
      return a ? allGnomes(s).filter((u) => u.id !== a.id) : [];
    }),
  ],
  hasAnyPlay: (s) => Object.values(s.units).filter((u) => u.kind === 'gnome').length >= 2,
  validate: (s, _p, t) => {
    const a = targetUnit(s, t, 0);
    const b = targetUnit(s, t, 1);
    if (!a || !b || a.kind !== 'gnome' || b.kind !== 'gnome') return 'both targets must be gnomes';
    if (a.id === b.id) return 'choose two different gnomes';
    return null;
  },
  resolve: (d, e) => {
    const a = targetUnit(d, e.targets, 0);
    const b = targetUnit(d, e.targets, 1);
    if (!a || !b) return fizzle(d, e, 'a newlywed vanished');
    d.marriages.push([a.id, b.id]);
    pushEvent(d, { type: 'gnomesMarried', unitA: a.id, unitB: b.id });
  },
};

const anotherGnomesTreasure: WhimsyCardDef = {
  id: 'another-gnomes-treasure',
  name: 'Another Gnomes Treasure',
  text: 'Choose a Whimsy card from the discard pile and put it into your hand.',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [
    cardZoneStep('Choose a card from the discard pile', (s) => [...new Set(s.discard)]),
  ],
  hasAnyPlay: (s) => s.discard.length > 0,
  validate: (s, _p, t) => {
    const id = t?.cards?.[0];
    if (!id) return 'choose a card from the discard pile';
    if (!s.discard.includes(id)) return `${id} is not in the discard pile`;
    return null;
  },
  resolve: (d, e) => {
    const id = e.targets?.cards?.[0] as CardId;
    const idx = d.discard.indexOf(id);
    if (idx < 0) return fizzle(d, e, 'the card left the discard pile');
    d.discard.splice(idx, 1);
    d.players[e.player].hand.push(id);
    pushEvent(d, { type: 'cardDrawn', player: e.player, cardId: id });
    enforceHandLimit(d, e.player);
  },
};

const mushroomCloud: WhimsyCardDef = {
  id: 'mushroom-cloud',
  name: 'Mushroom Cloud',
  text: 'Target non-Home garden and all gnomes on its space are destroyed.',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  targetFlow: () => [spaceStep('Choose a non-Home garden to nuke', (s) => nonHomeGardenSpaces(s))],
  hasAnyPlay: (s) => Object.values(s.gardens).some((g) => g.type !== 'home'),
  validate: (s, _p, t) => {
    const pos = targetSpace(t, 0);
    if (!pos || !inBounds(s, pos)) return 'space is off the board';
    const g = gardenAt(s, pos);
    if (!g) return 'there is no garden on that space';
    if (g.type === 'home') return 'Home Gardens cannot be nuked';
    return null;
  },
  resolve: (d, e) => {
    const pos = targetSpace(e.targets, 0) as Pos;
    const gnomes = unitsAt(d, pos).filter((u) => u.kind === 'gnome');
    for (const g of gnomes) destroyUnit(d, g.id, 'mushroom-cloud');
    destroyGarden(d, pos, 'card');
  },
};

const pocketShovel: WhimsyCardDef = {
  id: 'pocket-shovel',
  name: 'Pocket Shovel',
  text: 'Plant Tunnel Gardens on two empty spaces (one if only 1 tunnel tile remains).',
  timing: 'ritual',
  copies: 2,
  needsTargets: true,
  // Dynamic length: one empty-space step per tunnel tile remaining (max 2).
  // Each step excludes spaces already chosen, so no duplicate/reversed picks.
  targetFlow: (s) => {
    const required = Math.min(2, s.supply.tunnel);
    const step = (n: number) =>
      spaceStep(required === 1 ? 'Choose an empty space' : `Choose empty space ${n} of ${required}`, (st, ctx) => {
        const chosen = new Set((ctx.selected.spaces ?? []).map(posKey));
        return allBoardSpaces(st).filter((p) => isEmptySpace(st, p) && !chosen.has(posKey(p)));
      });
    return Array.from({ length: required }, (_, i) => step(i + 1));
  },
  hasAnyPlay: (s) => s.supply.tunnel > 0 && anyEmptySpace(s),
  validate: (s, _p, t) => {
    if (s.supply.tunnel <= 0) return 'the shared supply has no tunnel tiles left';
    const required = Math.min(2, s.supply.tunnel);
    const spaces = t?.spaces ?? [];
    if (spaces.length !== required) {
      return `choose exactly ${required} empty space(s) (tunnel tiles remaining: ${s.supply.tunnel})`;
    }
    for (const pos of spaces) {
      if (!inBounds(s, pos)) return 'space is off the board';
      if (!isEmptySpace(s, pos)) return `(${pos.x},${pos.y}) is not empty`;
    }
    if (spaces.length === 2 && samePos(spaces[0], spaces[1])) return 'choose two different spaces';
    return null;
  },
  resolve: (d, e) => {
    const turnNumber = requireTurn(d).number;
    for (const pos of e.targets?.spaces ?? []) {
      if (d.supply.tunnel <= 0) break;
      if (!isEmptySpace(d, pos)) {
        fizzle(d, e, `(${pos.x},${pos.y}) was no longer empty`);
        continue;
      }
      d.supply.tunnel -= 1;
      d.gardens[posKey(pos)] = makeGarden('tunnel', turnNumber);
      pushEvent(d, { type: 'gardenPlanted', player: e.player, pos: { ...pos }, gardenType: 'tunnel' });
    }
  },
};

const lostInTheMaize: WhimsyCardDef = {
  id: 'lost-in-the-maize',
  name: 'Lost In The Maize',
  text: "Gnomes can't leave Maize Gardens until your next turn.",
  timing: 'ritual',
  copies: 2,
  needsTargets: false,
  resolve: (d, e) => {
    d.timedEffects.push({ kind: 'lostInMaize', caster: e.player });
    pushEvent(d, { type: 'timedEffectStarted', kind: 'lostInMaize', player: e.player, pos: null });
  },
};

// ---------------------------------------------------------------------------
// Card data
// ---------------------------------------------------------------------------

export const CARD_DEFINITIONS: readonly WhimsyCardDef[] = [
  // Sudden Magic (10)
  hiddenPassage,
  snakeEyes,
  slipperyTrail,
  fourLeafClover,
  gustOfWind,
  gnomebodyDies,
  nopeGnome,
  gnomeBirthdayParty,
  gnomePlaceLikeHome,
  rocketPropelledGnome,
  // Ritual Magic (13)
  wildGrowth,
  instigation,
  lawnmowerOfDoom,
  plotTwist,
  greatWallOfWhimsy,
  sundownSabotage,
  ritualMagic,
  seeingDouble,
  gnomioAndJuliet,
  anotherGnomesTreasure,
  mushroomCloud,
  pocketShovel,
  lostInTheMaize,
];

/**
 * The 5 Curse Cards. All are passive rule changes the engine consults via
 * `state.activeCurses` (helpers.curseActive): plant cost (Compost Combustion),
 * harvest-phase snail moves (Snailmaggedon), turn-start sacrifices (Magic
 * Drain), attacker-wins-ties (Mulch Fever) and forced movement (Antsy Pants).
 */
export const CURSE_DEFINITIONS: readonly CurseCardDef[] = [
  {
    id: 'curse-compost-combustion',
    name: 'Compost Combustion',
    text: 'Gardens now cost 2 Wishes to plant.',
  },
  {
    id: 'curse-snailmaggedon',
    name: 'Snailmaggedon',
    text: "Snails can now move 1 space during every player's Harvest Phase.",
  },
  {
    id: 'curse-magic-drain',
    name: 'Magic Drain',
    text: 'If you start your turn at 0 Wishes, sacrifice a gnome.',
  },
  {
    id: 'curse-mulch-fever',
    name: 'Mulch Fever',
    text: 'If a fight would end in a tie, the attacker wins (no reroll).',
  },
  {
    id: 'curse-antsy-pants',
    name: 'Antsy Pants',
    text: 'Every gnome must move each turn, if able.',
  },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const cardById = new Map<CardId, WhimsyCardDef>(CARD_DEFINITIONS.map((c) => [c.id, c]));
const curseById = new Map<CardId, CurseCardDef>(CURSE_DEFINITIONS.map((c) => [c.id, c]));

export function getCardDef(id: CardId): WhimsyCardDef | null {
  return cardById.get(id) ?? null;
}

/**
 * TEST-ONLY seam: add a card definition to the lookup for the duration of a
 * test, returning a function that removes it again. Deliberately NOT exported
 * from `src/engine/index.ts` — it exists so tests can prove that the engine's
 * routing and enumeration are driven by card metadata rather than by hard-coded
 * card ids (e.g. registering a second `respondOnly` card). It does not touch
 * CARD_DEFINITIONS, so the deck composition is unaffected.
 */
export function __registerTestCard(def: WhimsyCardDef): () => void {
  if (cardById.has(def.id)) throw new Error(`card ${def.id} already exists`);
  cardById.set(def.id, def);
  return () => {
    cardById.delete(def.id);
  };
}

export function getCurseDef(id: CardId): CurseCardDef | null {
  return curseById.get(id) ?? null;
}

export function isCurseId(id: CardId): boolean {
  return curseById.has(id);
}

// ---------------------------------------------------------------------------
// Deck operations
// ---------------------------------------------------------------------------

/** Build the initial shuffled deck (curses excluded — they join on reshuffles). */
export function buildInitialDeck(draft: GameState): void {
  const ids: CardId[] = [];
  for (const def of CARD_DEFINITIONS) {
    for (let i = 0; i < def.copies; i++) ids.push(def.id);
  }
  draft.deck = draftShuffle(draft, ids);
  draft.cursePool = CURSE_DEFINITIONS.map((c) => c.id);
}

/**
 * When the deck is empty: shuffle the discard into a new deck and add one
 * random Curse Card from the pool (until all 5 are in play).
 */
function reshuffleIfNeeded(draft: GameState): void {
  if (draft.deck.length > 0 || draft.discard.length === 0) return;
  const pile: CardId[] = draft.discard.slice();
  draft.discard = [];
  let curseAdded: CardId | null = null;
  if (draft.cursePool.length > 0) {
    const idx = draftInt(draft, draft.cursePool.length);
    curseAdded = draft.cursePool[idx];
    draft.cursePool.splice(idx, 1);
    pile.push(curseAdded);
  }
  draft.deck = draftShuffle(draft, pile);
  pushEvent(draft, { type: 'deckReshuffled', curseAdded });
}

/** True when a draw is currently possible at all (ignoring wish cost). */
export function deckHasCards(state: GameState): boolean {
  return state.deck.length > 0 || state.discard.length > 0;
}

/**
 * Draw one card for `player` (reshuffling + curse injection as needed).
 * A drawn Curse is revealed face-up and resolves immediately: it becomes a
 * permanent active curse, never enters a hand or the reshuffle pool, and no
 * replacement card is drawn. Returns the drawn card id.
 */
export function drawOneCard(draft: GameState, player: PlayerId): CardId {
  reshuffleIfNeeded(draft);
  const id = draft.deck.pop();
  if (id === undefined) badArg('Cannot draw: no cards available');
  if (isCurseId(id)) {
    draft.activeCurses.push(id);
    pushEvent(draft, { type: 'curseRevealed', player, cardId: id });
    const def = getCurseDef(id);
    if (def?.onReveal) def.onReveal(draft);
    return id;
  }
  getPlayer(draft, player).hand.push(id);
  pushEvent(draft, { type: 'cardDrawn', player, cardId: id });
  return id;
}

// ---------------------------------------------------------------------------
// Playability
// ---------------------------------------------------------------------------

function cardPlayableIgnoringTiming(state: GameState, player: PlayerId, id: CardId): boolean {
  const def = getCardDef(id);
  if (!def) return false;
  if (def.hasAnyPlay && !def.hasAnyPlay(state, player)) return false;
  return true;
}

/** Sudden cards `player` may play inside a FIGHT Respond window (no Nope). */
export function playableFightRespondCards(state: GameState, player: PlayerId): CardId[] {
  const out: CardId[] = [];
  for (const id of new Set(getPlayer(state, player).hand)) {
    const def = getCardDef(id);
    if (!def || def.timing !== 'sudden' || def.respondOnly) continue;
    if (cardPlayableIgnoringTiming(state, player, id)) out.push(id);
  }
  return out;
}

/** Sudden cards `player` may play inside a CARD response window (incl. Nope). */
export function playableCardResponseCards(state: GameState, player: PlayerId): CardId[] {
  const out: CardId[] = [];
  for (const id of new Set(getPlayer(state, player).hand)) {
    const def = getCardDef(id);
    if (!def || def.timing !== 'sudden') continue;
    if (cardPlayableIgnoringTiming(state, player, id)) out.push(id);
  }
  return out;
}

/**
 * Why `player` cannot play `cardId` as a normal (non-window) play right now,
 * or null when it is playable. Timing: Sudden — any time no decision is
 * pending; Ritual — own turn's Action Phase only (see ENGINE_API.md
 * "interpretations").
 */
export function whyCannotPlayNow(state: GameState, player: PlayerId, cardId: CardId): string | null {
  const p = getPlayer(state, player);
  if (p.status !== 'playing') return 'eliminated players cannot play cards';
  if (!p.hand.includes(cardId)) return `card ${cardId} is not in hand`;
  const def = getCardDef(cardId);
  if (!def) return `unknown card: ${cardId}`;
  if (def.respondOnly) return `${def.name} can only be played in response to another card`;
  if (def.timing === 'ritual') {
    if (!state.turn || state.turn.activePlayer !== player || state.turn.phase !== 'action') {
      return `${def.name} is Ritual Magic: playable only during your own Action Phase`;
    }
  }
  if (def.hasAnyPlay && !def.hasAnyPlay(state, player)) {
    return `${def.name} has no legal targets right now`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The card stack (play → response windows → LIFO resolution)
// ---------------------------------------------------------------------------

/**
 * Move the card from hand to the discard, push it onto the stack and open
 * response windows for every other playing player. Throws on bad targets.
 * `respondsToStackIndex` is set when a `targetsRespondedCard` card (Nope-Gnome)
 * is played inside a response window; its `resolve` reads it off the entry.
 */
export function playCardFromHand(
  draft: GameState,
  player: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
  respondsToStackIndex?: number,
): void {
  const p = getPlayer(draft, player);
  const idx = p.hand.indexOf(cardId);
  if (idx < 0) badArg(`Card ${cardId} is not in ${p.name}'s hand`);
  const def = getCardDef(cardId);
  if (!def) badArg(`Unknown card: ${cardId}`);
  if (def.needsTargets || targets !== undefined) {
    const err = def.validate ? def.validate(draft, player, targets) : null;
    if (err) badArg(`${def.name}: ${err}`);
  }
  p.hand.splice(idx, 1);
  draft.discard.push(cardId); // a cancelled card still goes to the discard
  const entry: CardStackEntry = { player, cardId, cancelled: false };
  // Copy the payload rather than aliasing the caller's action object into the
  // state: enumerated actions share candidate Pos objects between them, and
  // game state must never hold a reference a caller still owns.
  if (targets !== undefined) entry.targets = structuredClone(targets);
  if (respondsToStackIndex !== undefined) entry.respondsToStackIndex = respondsToStackIndex;
  draft.cardStack.push(entry);
  pushEvent(draft, { type: 'cardPlayed', player, cardId });
  draft.responseQueue = otherPlayingPlayers(draft, player);
}

/**
 * Advance the card stack: auto-pass empty response windows, surface a
 * cardResponse decision when a player can respond, otherwise resolve the top
 * card (LIFO). Called from the engine's settle loop; guaranteed to make
 * progress each call.
 */
export function progressCardStack(draft: GameState): void {
  while (draft.responseQueue.length > 0) {
    const responder = draft.responseQueue[0];
    const playable = playableCardResponseCards(draft, responder);
    if (playable.length > 0) {
      const top = draft.cardStack[draft.cardStack.length - 1];
      draft.pendingDecision = {
        kind: 'cardResponse',
        player: responder,
        respondingToCard: top.cardId,
        respondingToPlayer: top.player,
        stackIndex: draft.cardStack.length - 1,
        playableCards: playable,
      };
      return;
    }
    draft.responseQueue.shift();
  }

  const entry = draft.cardStack.pop();
  if (!entry) return;
  if (!entry.cancelled) {
    const def = getCardDef(entry.cardId);
    if (def) {
      const err =
        def.needsTargets || entry.targets !== undefined
          ? def.validate
            ? def.validate(draft, entry.player, entry.targets)
            : null
          : null;
      if (err) {
        fizzle(draft, entry, err);
      } else {
        pushEvent(draft, { type: 'cardResolved', player: entry.player, cardId: entry.cardId });
        def.resolve(draft, entry);
      }
    }
  }
  // A fresh response round for the (not yet resolved) new top of the stack.
  const top = draft.cardStack[draft.cardStack.length - 1];
  draft.responseQueue = top && !top.cancelled ? otherPlayingPlayers(draft, top.player) : [];
}

/** Pass in a cardResponse window. */
export function handleCardResponsePass(draft: GameState, player: PlayerId): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'cardResponse') badArg('No card response window is open');
  if (d.player !== player) badArg(`It is player ${d.player}'s response window, not player ${player}'s`);
  draft.pendingDecision = null;
  if (draft.responseQueue[0] === player) draft.responseQueue.shift();
}

/**
 * Play a Sudden Magic card inside a cardResponse window (targets already
 * chosen, or none needed). Phased targeting for a card that still needs targets
 * is routed separately (targeting.ts) and lands back in `commitCardResponsePlay`
 * once the last target is picked.
 */
export function handleCardResponsePlay(
  draft: GameState,
  player: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'cardResponse') badArg('No card response window is open');
  if (d.player !== player) badArg(`It is player ${d.player}'s response window, not player ${player}'s`);
  if (!d.playableCards.includes(cardId)) {
    badArg(`Card ${cardId} is not playable in this response window`);
  }
  commitCardResponsePlay(draft, player, cardId, targets, d.stackIndex);
}

/**
 * Commit a card-response play: close the window, advance the response queue and
 * push the card onto the stack. Shared by the immediate path (above) and the
 * completion of phased targeting, so both do the identical bookkeeping.
 * `stackIndex` is the entry being responded to — recorded on the new stack
 * entry only for cards flagged `targetsRespondedCard` (generic; no card ids).
 */
export function commitCardResponsePlay(
  draft: GameState,
  player: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
  stackIndex: number,
): void {
  const def = getCardDef(cardId);
  const respondsToStackIndex = def?.targetsRespondedCard ? stackIndex : undefined;
  draft.pendingDecision = null;
  if (draft.responseQueue[0] === player) draft.responseQueue.shift();
  playCardFromHand(draft, player, cardId, targets, respondsToStackIndex);
}
