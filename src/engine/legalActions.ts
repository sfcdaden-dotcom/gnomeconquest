/**
 * Legal-action enumeration.
 *
 * THE CONTRACT: every action returned by `getLegalActions` is complete and
 * immediately executable — `applyAction(state, action)` will not reject it for
 * missing or invalid targets. Targeted cards are expanded into one action per
 * valid `CardTargets` payload, so a consumer (AI, UI, fuzzer) never needs
 * card-specific knowledge to finish building an action the engine called legal.
 *
 * Two lower-level entry points exist for consumers that do not want the
 * expansion (it is quadratic in the board for two-space cards):
 *
 *   getLegalActionIntents(state)      → the same actions, card plays WITHOUT
 *                                       targets (cheap; not directly
 *                                       dispatchable for targeted cards)
 *   getTargetOptions(state, intent)   → every valid CardTargets payload for
 *                                       one such intent
 *
 * `getLegalActions` is exactly the composition of the two. A UI that builds
 * pickers incrementally uses the pair (filter the payload list by the picks so
 * far); a UI that just wants buttons uses `getLegalActions`.
 *
 * Enumeration is generic: candidate values come from the card's `targetSpec`
 * slot kinds, and the card's own `validate` is the only judge of which
 * combinations survive. Adding a card requires no change to this file.
 */

import type {
  Action,
  CardId,
  CardTargets,
  GameState,
  PlantableGardenType,
  PlayerId,
  Pos,
  UnitId,
} from './types';
import type { TargetSpec } from './cards';
import { getCardDef, deckHasCards, whyCannotPlayNow } from './cards';
import { internal, plantWishCost, playerUnits, posKey } from './helpers';
import { canPlantAt } from './gardens';
import { antsyPantsViolators, getPlayerToAct, moveDestinations } from './turns';

/**
 * Work limit on the combinatorial expansion of one card's targets, counted in
 * candidate payloads examined (not payloads returned).
 *
 * Exceeding it throws rather than truncating. Truncating would silently drop
 * legal plays — and because the limit counts candidates *examined*, the drops
 * would not even be proportional to a card's own breadth: a narrow card like
 * Plot Twist (2·n·(n-1) valid pairs) shares the budget with the rejected
 * pairs, so it would quietly lose plays long before its own output got large.
 * A loud failure keeps the promise that what `getLegalActions` returns is the
 * complete set.
 *
 * Headroom: the widest shipped card is a two-space card, costing C(n², 2)
 * candidates — 1,176 on the default 7×7, 7,260 on 11×11, 14,196 on 13×13. The
 * limit is first reached at 15×15 (25,200), which no game configuration
 * produces: the setup UI does not expose board size and the custom-preset
 * editor is fixed at 7×7, so this is reachable only by calling `createGame`
 * directly with `boardSize >= 15`. See TECH_DEBT.md for the real fix
 * (per-slot candidate pruning before the cartesian product).
 */
export const MAX_TARGET_COMBINATIONS = 20000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Every legal, fully-executable action for `player` (default: the player who
 * must act — see getPlayerToAct). For a non-active player with no pending
 * decision this returns only their playable Sudden Magic interrupts.
 */
export function getLegalActions(state: GameState, player?: PlayerId): Action[] {
  const out: Action[] = [];
  for (const intent of getLegalActionIntents(state, player)) {
    if (intent.type !== 'playCard' && intent.type !== 'respondPlayCard') {
      out.push(intent);
      continue;
    }
    const payloads = getTargetOptions(state, intent);
    if (payloads.length === 0) {
      // Untargeted card (needsTargets false) — the intent is already complete.
      // A targeted card with no valid payload is NOT legal and is dropped:
      // `hasAnyPlay` normally prevents this, but a card whose cheap existence
      // check is coarser than its `validate` would otherwise leak an
      // unplayable action into the enumeration.
      if (!cardNeedsTargets(intent.cardId)) out.push(intent);
      continue;
    }
    for (const targets of payloads) out.push({ ...intent, targets });
  }
  return out;
}

/**
 * Legal actions with card plays left UNTARGETED. Cheap: no combinatorial
 * expansion. `playCard` / `respondPlayCard` entries for targeted cards are
 * intents, not dispatchable actions — complete them with `getTargetOptions`.
 */
export function getLegalActionIntents(state: GameState, player?: PlayerId): Action[] {
  if (state.status === 'finished') return [];
  const actor = player ?? getPlayerToAct(state);
  if (actor === null) return [];

  const d = state.pendingDecision;
  if (d) {
    if (d.player !== actor) return [];
    switch (d.kind) {
      case 'rollOff':
        return [{ type: 'rollOff', player: actor }];
      case 'chooseHarvest':
        return d.options.map((s) => ({ type: 'chooseHarvest', player: actor, sourceKey: s.key }));
      case 'homeHarvest':
        return d.options.map((take) => ({ type: 'homeHarvest', player: actor, take }));
      case 'mushroomClones': {
        const out: Action[] = [];
        for (let c = 0; c <= d.max; c++) out.push({ type: 'mushroomClones', player: actor, count: c });
        return out;
      }
      case 'slide': {
        const out: Action[] = d.options.map((to) => ({ type: 'slide', player: actor, to }));
        if (d.optional) out.push({ type: 'declineEffect', player: actor });
        return out;
      }
      case 'tunnel': {
        const out: Action[] = d.options.map((to) => ({ type: 'tunnel', player: actor, to }));
        if (d.optional) out.push({ type: 'declineEffect', player: actor });
        return out;
      }
      case 'fightRespond': {
        const out: Action[] = [{ type: 'respondPass', player: actor }];
        for (const cardId of d.playableCards) {
          out.push({ type: 'respondPlayCard', player: actor, cardId });
        }
        return out;
      }
      case 'cardResponse': {
        const out: Action[] = [{ type: 'respondPass', player: actor }];
        for (const cardId of d.playableCards) {
          out.push({ type: 'respondPlayCard', player: actor, cardId });
        }
        return out;
      }
      case 'discard':
        return [...new Set(state.players[actor].hand)].map((cardId) => ({
          type: 'discardCard',
          player: actor,
          cardId,
        }));
      case 'snailify':
        return [
          { type: 'snailify', player: actor, accept: true },
          { type: 'snailify', player: actor, accept: false },
        ];
      case 'sacrificeGnome':
        return d.options.map((unitId) => ({ type: 'sacrificeGnome', player: actor, unitId }));
      case 'snailMove': {
        const out: Action[] = d.options.map((to) => ({ type: 'snailMove', player: actor, to }));
        out.push({ type: 'declineEffect', player: actor }); // the move is optional
        return out;
      }
      default: {
        // Exhaustiveness: a new PendingDecision kind must be handled here.
        const missing: never = d;
        internal(`getLegalActions: unhandled decision kind ${JSON.stringify(missing)}`);
      }
    }
  }

  if (state.status === 'rolloff') return []; // decision covers roll-off; nothing else

  const t = state.turn;
  if (!t || t.phase !== 'action') return [];
  const p = state.players[actor];

  // Non-active players: sudden-magic interrupts only. (whyCannotPlayNow
  // already rejects respond-only cards and, for a non-active player, all
  // Ritual Magic — anything that passes is a playable Sudden interrupt.)
  if (t.activePlayer !== actor) {
    const out: Action[] = [];
    if (p.status === 'playing') {
      for (const cardId of new Set(p.hand)) {
        if (whyCannotPlayNow(state, actor, cardId) === null) {
          out.push({ type: 'playCard', player: actor, cardId });
        }
      }
    }
    return out;
  }

  const out: Action[] = [];

  // Moves (shared legality with doMove and the Antsy Pants check).
  for (const u of playerUnits(state, actor)) {
    if (u.movedOnTurn === t.number) continue;
    for (const to of moveDestinations(state, u)) {
      out.push({ type: 'move', player: actor, unitId: u.id, to });
    }
  }

  if (p.status === 'playing') {
    // Plants.
    if (p.wishes >= plantWishCost(state)) {
      const spots = new Map<string, Pos>();
      for (const u of playerUnits(state, actor)) {
        if (u.kind !== 'gnome') continue;
        if (canPlantAt(state, actor, u.pos)) spots.set(posKey(u.pos), u.pos);
      }
      const types = Object.keys(state.supply) as Array<keyof GameState['supply']>;
      for (const pos of spots.values()) {
        for (const gt of types) {
          if (state.supply[gt] > 0) out.push({ type: 'plant', player: actor, pos, gardenType: gt });
        }
      }
    }

    // Draw.
    if (p.wishes >= 1 && deckHasCards(state)) {
      out.push({ type: 'drawCard', player: actor });
    }

    // Play cards.
    for (const cardId of new Set(p.hand)) {
      if (whyCannotPlayNow(state, actor, cardId) === null) {
        out.push({ type: 'playCard', player: actor, cardId });
      }
    }
  }

  // Antsy Pants can forbid ending the turn while a gnome can still move.
  if (antsyPantsViolators(state, actor).length === 0) {
    out.push({ type: 'endTurn', player: actor });
  }
  return out;
}

/**
 * Every valid `CardTargets` payload for a `playCard` / `respondPlayCard`
 * intent, in a deterministic order. Empty for untargeted cards (play the
 * intent as-is) and for any other action type.
 *
 * The payloads are exactly those the card's own `validate` accepts, so a UI
 * can narrow them against partial picks without knowing any card rules.
 */
export function getTargetOptions(state: GameState, intent: Action): CardTargets[] {
  if (intent.type !== 'playCard' && intent.type !== 'respondPlayCard') return [];
  const def = getCardDef(intent.cardId);
  if (!def || !def.needsTargets || !def.targetSpec) return [];

  const slots = buildSlots(state, def.targetSpec);
  const combos: CardTargets[] = [];
  const accept = (targets: CardTargets) => {
    if (!def.validate || def.validate(state, intent.player, targets) === null) combos.push(targets);
  };
  expandSlots(slots, 0, {}, accept, {
    examined: 0,
    describe: () =>
      `enumerating targets for ${intent.cardId} on a ${state.config.boardSize}×${state.config.boardSize} board ` +
      `exceeded MAX_TARGET_COMBINATIONS (${MAX_TARGET_COMBINATIONS}); the enumeration would be incomplete`,
  });
  return combos;
}

// ---------------------------------------------------------------------------
// Generic target enumeration
// ---------------------------------------------------------------------------

/** One targeting slot reduced to "pick `count` of these candidates". */
interface Slot {
  key: keyof CardTargets;
  count: number;
  ordered: boolean;
  /** Single-value slot (gardenType) rather than an array. */
  scalar: boolean;
  candidates: unknown[];
}

function cardNeedsTargets(cardId: CardId): boolean {
  const def = getCardDef(cardId);
  return !!def && def.needsTargets;
}

/**
 * Candidate domains per slot kind. Deliberately broad — the card's `validate`
 * does the filtering, so this never encodes a card's rules. Order is
 * deterministic (sorted ids, row-major spaces, seat order).
 */
function buildSlots(state: GameState, spec: TargetSpec): Slot[] {
  const slots: Slot[] = [];
  if (spec.units) {
    const units: UnitId[] = Object.keys(state.units).sort();
    slots.push({
      key: 'units',
      count: spec.units.count,
      ordered: spec.units.ordered === true,
      scalar: false,
      candidates: units,
    });
  }
  if (spec.spaces) {
    const spaces: Pos[] = [];
    const n = state.config.boardSize;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) spaces.push({ x, y });
    }
    slots.push({
      key: 'spaces',
      count: spec.spaces.count,
      ordered: spec.spaces.ordered === true,
      scalar: false,
      candidates: spaces,
    });
  }
  if (spec.players) {
    slots.push({
      key: 'players',
      count: spec.players.count,
      ordered: false,
      scalar: false,
      candidates: state.players.map((p) => p.id as PlayerId),
    });
  }
  if (spec.cards) {
    // Only the discard zone exists today; `from` is carried on the spec so a
    // future zone lands here rather than in a card-specific branch.
    const zone = spec.cards.from === 'discard' ? state.discard : [];
    slots.push({
      key: 'cards',
      count: spec.cards.count,
      ordered: false,
      scalar: false,
      candidates: [...new Set(zone)],
    });
  }
  if (spec.gardenType) {
    slots.push({
      key: 'gardenType',
      count: 1,
      ordered: false,
      scalar: true,
      candidates: Object.keys(state.supply) as PlantableGardenType[],
    });
  }
  return slots;
}

/**
 * Recursive cartesian product across slots, emitting complete payloads.
 * Throws rather than truncating when the work budget is exhausted — see
 * MAX_TARGET_COMBINATIONS.
 */
interface Budget {
  examined: number;
  describe: () => string;
}

function expandSlots(
  slots: Slot[],
  idx: number,
  acc: CardTargets,
  emit: (targets: CardTargets) => void,
  budget: Budget,
): void {
  if (idx >= slots.length) {
    budget.examined += 1;
    if (budget.examined > MAX_TARGET_COMBINATIONS) internal(budget.describe());
    emit({ ...acc });
    return;
  }
  const slot = slots[idx];
  for (const choice of chooseFrom(slot)) {
    const next: CardTargets = { ...acc };
    if (slot.scalar) {
      (next as Record<string, unknown>)[slot.key] = choice[0];
    } else {
      (next as Record<string, unknown>)[slot.key] = choice;
    }
    expandSlots(slots, idx + 1, next, emit, budget);
  }
}

/**
 * All ways to pick `slot.count` candidates: permutations when the slot is
 * `ordered` (Instigation's attacker/defender), combinations otherwise.
 */
function chooseFrom(slot: Slot): unknown[][] {
  const out: unknown[][] = [];
  const pick: unknown[] = [];
  const used = new Set<number>();
  const recurse = (start: number) => {
    if (pick.length === slot.count) {
      out.push([...pick]);
      return;
    }
    for (let i = slot.ordered ? 0 : start; i < slot.candidates.length; i++) {
      if (slot.ordered && used.has(i)) continue;
      used.add(i);
      pick.push(slot.candidates[i]);
      recurse(i + 1);
      pick.pop();
      used.delete(i);
    }
  };
  recurse(0);
  return out;
}
