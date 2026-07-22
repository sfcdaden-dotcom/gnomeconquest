/**
 * Action-Phase actions (move / plant / draw / play a card) and the dispatch
 * router that maps an `Action` onto the handler that performs it.
 *
 * Every handler validates first and throws EngineError before touching the
 * draft, so a rejected action leaves the caller's state untouched (applyAction
 * clones before dispatching, so partial mutation of the draft is impossible to
 * observe anyway).
 */

import type { Action, CardTargets, GameState, PlayerId, Pos } from './types';
import {
  badArg,
  enemyUnitsAt,
  enforceHandLimit,
  entryBlockedByWall,
  gardenAt,
  getPlayer,
  gnomeExitBlocked,
  illegal,
  inBounds,
  isOrthAdjacent,
  maizeExitCost,
  plantWishCost,
  posKey,
  pushEvent,
  requireTurn,
  spendWishes,
} from './helpers';
import { handleRespondPass, handleRespondPlayCard } from './fights';
import {
  canPlantAt,
  handleEntry,
  makeGarden,
  resolveChooseHarvest,
  resolveDeclineEffect,
  resolveHomeHarvest,
  resolveMushroomClones,
  resolveSlide,
  resolveSnailMove,
  resolveTunnel,
} from './gardens';
import {
  deckHasCards,
  drawOneCard,
  handleCardResponsePass,
  handleCardResponsePlay,
  playCardFromHand,
  whyCannotPlayNow,
} from './cards';
import { doSacrificeGnome, doSnailify } from './elimination';
import { doEndTurn, doRollOff, requireActionPhaseActor } from './turns';

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function dispatch(draft: GameState, action: Action): void {
  switch (action.type) {
    case 'rollOff':
      return doRollOff(draft, action.player);
    case 'chooseHarvest':
      return resolveChooseHarvest(draft, action.player, action.sourceKey);
    case 'homeHarvest':
      return resolveHomeHarvest(draft, action.player, action.take);
    case 'mushroomClones':
      return resolveMushroomClones(draft, action.player, action.count);
    case 'slide':
      return resolveSlide(draft, action.player, action.to);
    case 'tunnel':
      return resolveTunnel(draft, action.player, action.to);
    case 'declineEffect':
      return resolveDeclineEffect(draft, action.player);
    case 'respondPass':
      // Respond windows come in two flavors; route by the open decision.
      return draft.pendingDecision?.kind === 'cardResponse'
        ? handleCardResponsePass(draft, action.player)
        : handleRespondPass(draft, action.player);
    case 'respondPlayCard':
      return draft.pendingDecision?.kind === 'cardResponse'
        ? handleCardResponsePlay(draft, action.player, action.cardId, action.targets)
        : handleRespondPlayCard(draft, action.player, action.cardId, action.targets);
    case 'discardCard':
      return doDiscardCard(draft, action.player, action.cardId);
    case 'snailify':
      return doSnailify(draft, action.player, action.accept);
    case 'sacrificeGnome':
      return doSacrificeGnome(draft, action.player, action.unitId);
    case 'snailMove':
      return resolveSnailMove(draft, action.player, action.to);
    case 'move':
      return doMove(draft, action.player, action.unitId, action.to);
    case 'plant':
      return doPlant(draft, action.player, action.pos, action.gardenType);
    case 'drawCard':
      return doDrawCard(draft, action.player);
    case 'playCard':
      return doPlayCard(draft, action.player, action.cardId, action.targets);
    case 'endTurn':
      return doEndTurn(draft, action.player);
    default: {
      const t: never = action;
      badArg(`Unknown action type: ${JSON.stringify(t)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Action-Phase handlers
// ---------------------------------------------------------------------------

function doMove(draft: GameState, player: PlayerId, unitId: string, to: Pos): void {
  requireActionPhaseActor(draft, player);
  const t = requireTurn(draft);
  const unit = draft.units[unitId];
  if (!unit) badArg(`No such unit: ${unitId}`);
  if (unit.owner !== player) illegal(`Unit ${unitId} is not controlled by player ${player}`);
  if (unit.movedOnTurn === t.number) illegal(`Unit ${unitId} has already moved this turn (1 space per turn)`);
  if (!inBounds(draft, to)) badArg(`(${to.x},${to.y}) is off the board`);
  if (!isOrthAdjacent(unit.pos, to)) {
    illegal(`Units move exactly 1 orthogonal space; (${to.x},${to.y}) is not adjacent to (${unit.pos.x},${unit.pos.y})`);
  }
  const locked = gnomeExitBlocked(draft, unit);
  if (locked) illegal(locked);
  if (entryBlockedByWall(draft, to)) {
    illegal(`The Great Wall Of Whimsy blocks entry to (${to.x},${to.y})`);
  }

  // Maize exit gating: pay or stay.
  const cost = maizeExitCost(draft, unit.pos);
  if (cost > 0) {
    const p = getPlayer(draft, player);
    if (p.wishes < cost) {
      illegal(`Cannot exit the Maize Garden at (${unit.pos.x},${unit.pos.y}): exit costs ${cost} Wish(es), you have ${p.wishes}`);
    }
    spendWishes(draft, player, cost, 'maize exit');
    pushEvent(draft, { type: 'maizeExitPaid', player, pos: { ...unit.pos }, cost });
  }

  const from = { ...unit.pos };
  unit.movedOnTurn = t.number;
  unit.pos = { x: to.x, y: to.y };
  pushEvent(draft, { type: 'unitMoved', player, unitId, from, to: unit.pos });
  handleEntry(draft, unitId);
}

function doPlant(draft: GameState, player: PlayerId, pos: Pos, gardenType: string): void {
  requireActionPhaseActor(draft, player);
  const t = requireTurn(draft);
  const p = getPlayer(draft, player);
  if (p.status !== 'playing') illegal('Snails cannot plant gardens');
  if (gardenType === 'home') illegal('A second Home Garden can never be planted');
  if (!(gardenType in draft.supply)) badArg(`Unknown garden type: ${gardenType}`);
  const gt = gardenType as keyof GameState['supply'];
  if (!inBounds(draft, pos)) badArg(`(${pos.x},${pos.y}) is off the board`);
  if (gardenAt(draft, pos)) illegal(`(${pos.x},${pos.y}) already has a garden`);
  if (enemyUnitsAt(draft, pos, player).length > 0) illegal(`(${pos.x},${pos.y}) contains enemy critters`);
  if (!canPlantAt(draft, player, pos)) {
    illegal(`You need one of your gnomes on (${pos.x},${pos.y}) to plant there`);
  }
  if (draft.supply[gt] <= 0) illegal(`The shared supply has no ${gardenType} tiles left`);
  const cost = plantWishCost(draft); // 1, or 2 under Compost Combustion
  if (p.wishes < cost) illegal(`Planting a garden costs ${cost} Wish(es)`);

  spendWishes(draft, player, cost, 'plant garden');
  draft.supply[gt] -= 1;
  draft.gardens[posKey(pos)] = makeGarden(gt, t.number);
  pushEvent(draft, { type: 'gardenPlanted', player, pos: { ...pos }, gardenType: gt });
}

function doDrawCard(draft: GameState, player: PlayerId): void {
  requireActionPhaseActor(draft, player);
  const p = getPlayer(draft, player);
  if (p.status !== 'playing') illegal('Snails cannot draw cards');
  if (!deckHasCards(draft)) {
    illegal('No Whimsy Cards are available (deck and discard pile are both empty)');
  }
  if (p.wishes < 1) illegal('Drawing a Whimsy Card costs 1 Wish');
  spendWishes(draft, player, 1, 'draw card');
  drawOneCard(draft, player);
  enforceHandLimit(draft, player);
}

function doDiscardCard(draft: GameState, player: PlayerId, cardId: string): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'discard') illegal('No discard decision is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s discard, not player ${player}'s`);
  const p = getPlayer(draft, player);
  const idx = p.hand.indexOf(cardId);
  if (idx < 0) badArg(`Card ${cardId} is not in hand`);
  p.hand.splice(idx, 1);
  draft.discard.push(cardId);
  pushEvent(draft, { type: 'cardDiscarded', player, cardId });
  draft.pendingDecision = null;
  enforceHandLimit(draft, player);
}

function doPlayCard(draft: GameState, player: PlayerId, cardId: string, targets: CardTargets | undefined): void {
  if (draft.status !== 'playing') illegal('The game has not started yet');
  if (draft.pendingDecision) {
    const k = draft.pendingDecision.kind;
    illegal(
      k === 'fightRespond' || k === 'cardResponse'
        ? 'Use respondPlayCard inside a Respond window'
        : `A "${k}" decision must be resolved before playing cards`,
    );
  }
  // whyCannotPlayNow covers status, hand membership, respond-only cards,
  // Ritual timing and target existence in one place.
  const why = whyCannotPlayNow(draft, player, cardId);
  if (why) illegal(why);
  playCardFromHand(draft, player, cardId, targets);
}
