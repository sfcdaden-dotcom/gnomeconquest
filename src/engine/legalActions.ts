/**
 * Legal-action enumeration.
 *
 * PRIMARY API — `getLegalActionIntents(state[, player])`: every legal move for
 * the player who must act, with card plays left UNTARGETED. It is cheap (no
 * combinatorial work) and it is what the UI and the AI actually use. A targeted
 * `playCard` / `respondPlayCard` entry is an *intent*: dispatching it without a
 * `targets` payload starts phased targeting (a `cardTargeting` decision), and
 * the engine then offers one target step at a time (`getPendingDecisionOptions`
 * → `selectTarget`). So the "how do I finish this play" knowledge lives in the
 * engine's phased flow, not in the caller.
 *
 * ANALYSIS HELPER — `getLegalActions` / `enumerateCompleteCardActions`: the same
 * actions but with every targeted card expanded into one fully-built,
 * immediately-executable action per valid `CardTargets` payload. This is the
 * expensive path (it walks each card's whole targeting flow) and it is used
 * only by tests and offline analysis — never by the UI or the normal AI loop.
 * Because expansion is phased (each step yields only its own legal options,
 * narrowed by earlier picks), its cost is proportional to a card's real
 * branching rather than the product of every slot, and there is no global
 * combination ceiling.
 *
 * Enumeration is generic: candidates come from each card's `targetFlow` steps
 * and the card's own `validate` is the only judge of complete payloads. Adding
 * a card requires no change to this file.
 */

import type { Action, GameState, PlayerId, Pos } from './types';
import { getCardDef, deckHasCards, whyCannotPlayNow } from './cards';
import { enumerateCardTargets, getPendingDecisionOptions } from './targeting';
import { internal, plantWishCost, playerUnits, posKey } from './helpers';
import { canPlantAt } from './gardens';
import { antsyPantsViolators, getPlayerToAct, moveDestinations } from './turns';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Every legal, fully-executable action for `player` (default: the player who
 * must act), with targeted card plays expanded into one action per valid
 * `CardTargets` payload. Alias of `enumerateCompleteCardActions` — the
 * expensive analysis/testing path; UI and normal AI use
 * `getLegalActionIntents`.
 */
export function getLegalActions(state: GameState, player?: PlayerId): Action[] {
  return enumerateCompleteCardActions(state, player);
}

/**
 * The complete, executable expansion: `getLegalActionIntents` with every
 * targeted `playCard` / `respondPlayCard` intent replaced by one action per
 * valid target payload (dropping a targeted card that has no valid payload).
 */
export function enumerateCompleteCardActions(state: GameState, player?: PlayerId): Action[] {
  const out: Action[] = [];
  for (const intent of getLegalActionIntents(state, player)) {
    if (intent.type !== 'playCard' && intent.type !== 'respondPlayCard') {
      out.push(intent);
      continue;
    }
    if (!cardNeedsTargets(intent.cardId)) {
      // Untargeted card — the intent is already complete.
      out.push(intent);
      continue;
    }
    // Targeted: expand. A card with no valid payload contributes nothing (it is
    // dropped, matching the "everything returned is executable" contract).
    for (const targets of enumerateCardTargets(state, intent.player, intent.cardId)) {
      out.push({ ...intent, targets });
    }
  }
  return out;
}

/**
 * Legal actions with card plays left UNTARGETED. Cheap: no combinatorial
 * expansion. A `playCard` / `respondPlayCard` entry for a targeted card is an
 * intent — dispatch it to start phased targeting. While a `cardTargeting`
 * decision is open this returns the current step's `selectTarget` options plus
 * `cancelTargeting`.
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
      case 'cardTargeting': {
        // Answers to the current targeting step: one selectTarget per legal
        // option, plus the always-available cancel.
        const out: Action[] = getPendingDecisionOptions(state).map((target) => ({
          type: 'selectTarget',
          player: actor,
          target,
        }));
        out.push({ type: 'cancelTargeting', player: actor });
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cardNeedsTargets(cardId: string): boolean {
  const def = getCardDef(cardId);
  return !!def && def.needsTargets;
}
