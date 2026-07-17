/**
 * Core engine: reducer-style API.
 *
 *   applyAction(state, action) → new GameState   (pure; input never mutated;
 *                                                 illegal actions throw EngineError)
 *   getLegalActions(state[, player]) → Action[]  (enumerated legal actions for
 *                                                 the player who must act)
 *   getPlayerToAct(state) → PlayerId | null
 *
 * After applying the requested action, the engine "settles": it auto-advances
 * everything that needs no human input (empty Respond windows, dice rolls,
 * single-option harvests, queued fights, eliminations, forced turn ends) and
 * stops when it either needs a decision (`state.pendingDecision`) or is idle
 * in the active player's Action Phase.
 */

import type {
  Action,
  CardTargets,
  GameState,
  PlayerId,
  Pos,
  Unit,
} from './types';
import {
  CURSE_ANTSY_PANTS,
  CURSE_MAGIC_DRAIN,
  badArg,
  curseActive,
  destroyGarden,
  destroyUnit,
  dissolveMarriages,
  draftRollD6,
  enemyUnitsAt,
  enforceHandLimit,
  entryBlockedByWall,
  gardenAt,
  getPlayer,
  gnomeExitBlocked,
  gnomesOnBoard,
  illegal,
  inBounds,
  internal,
  isOrthAdjacent,
  maizeExitCost,
  orthNeighbors,
  plantWishCost,
  playerUnits,
  posKey,
  pushEvent,
  requireTurn,
  spendWishes,
} from './helpers';
import {
  handleRespondPass,
  handleRespondPlayCard,
  progressFight,
  startNextQueuedFight,
} from './fights';
import {
  canPlantAt,
  continueHarvest,
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
  progressCardStack,
  whyCannotPlayNow,
} from './cards';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The player who must act right now: the pendingDecision's player if one is
 * set, otherwise the active player. Null when the game is finished.
 */
export function getPlayerToAct(state: GameState): PlayerId | null {
  if (state.status === 'finished') return null;
  if (state.pendingDecision) return state.pendingDecision.player;
  if (state.turn) return state.turn.activePlayer;
  return null;
}

export function isGameOver(state: GameState): boolean {
  return state.status === 'finished';
}

/**
 * Validate and apply one action, returning a NEW state (the input is never
 * mutated). Illegal or malformed actions throw EngineError with a clear
 * message and leave the input state untouched.
 */
/**
 * Events kept on the state (rolling window). Bounds the per-action clone cost
 * so thousands-of-actions simulations stay O(actions), not O(actions²).
 */
const MAX_EVENTS = 1000;

export function applyAction(state: GameState, action: Action): GameState {
  if (state.status === 'finished') {
    illegal(`The game is over (winner: ${state.winner === null ? 'none' : state.winner})`);
  }
  const draft = structuredClone(state) as GameState;
  dispatch(draft, action);
  settle(draft);
  if (draft.events.length > MAX_EVENTS) {
    draft.events.splice(0, draft.events.length - MAX_EVENTS);
  }
  return draft;
}

function dispatch(draft: GameState, action: Action): void {
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
// Settle loop — auto-advance until a decision or Action-Phase idle
// ---------------------------------------------------------------------------

function settle(draft: GameState): void {
  for (let guard = 0; guard < 100000; guard++) {
    if (draft.status === 'finished') {
      draft.pendingDecision = null;
      return;
    }
    if (draft.pendingDecision) return;
    // The card stack outranks everything: a card played inside a fight's
    // Respond window (or any other interrupt) must fully resolve — including
    // its own response windows — before the interrupted thing continues.
    if (draft.cardStack.length > 0) {
      progressCardStack(draft);
      continue;
    }
    if (draft.fight) {
      progressFight(draft);
      continue;
    }
    if (draft.eliminationQueue.length > 0) {
      processNextElimination(draft);
      continue;
    }
    if (draft.fightQueue.length > 0) {
      startNextQueuedFight(draft);
      continue;
    }
    if (draft.status === 'rolloff') return; // rollOff decision is always pending here
    if (draft.turnMustEnd) {
      endTurnInternal(draft);
      continue;
    }
    const t = requireTurn(draft);
    if (t.phase === 'harvest') {
      continueHarvest(draft);
      continue;
    }
    return; // Action Phase, waiting for the active player
  }
  internal('settle loop did not converge (engine bug)');
}

// ---------------------------------------------------------------------------
// Roll-off
// ---------------------------------------------------------------------------

function doRollOff(draft: GameState, player: PlayerId): void {
  const d = draft.pendingDecision;
  if (draft.status !== 'rolloff' || !d || d.kind !== 'rollOff' || !draft.rolloff) {
    illegal('No turn-order roll-off is pending');
  }
  if (d.player !== player) illegal(`It is player ${d.player}'s roll, not player ${player}'s`);
  const r = draft.rolloff;
  const roll = draftRollD6(draft);
  r.rolls[player] = roll;
  pushEvent(draft, { type: 'rollOffRolled', player, roll });
  r.pending = r.pending.filter((p) => p !== player);
  draft.pendingDecision = null;

  if (r.pending.length > 0) {
    draft.pendingDecision = { kind: 'rollOff', player: r.pending[0] };
    return;
  }

  const rolls = r.participants.map((pid) => ({ pid, roll: r.rolls[pid] ?? 0 }));
  const best = Math.max(...rolls.map((x) => x.roll));
  const winners = rolls.filter((x) => x.roll === best).map((x) => x.pid);
  if (winners.length > 1) {
    pushEvent(draft, { type: 'rollOffTie', players: winners });
    r.participants = winners;
    r.pending = [...winners];
    for (const w of winners) r.rolls[w] = null;
    draft.pendingDecision = { kind: 'rollOff', player: r.pending[0] };
    return;
  }

  const first = winners[0];
  pushEvent(draft, { type: 'turnOrderDetermined', first });
  draft.status = 'playing';
  draft.rolloff = null;
  startTurn(draft, first, 1);
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

function startTurn(draft: GameState, player: PlayerId, turnNumber: number): void {
  const p = getPlayer(draft, player);
  draft.turn = {
    number: turnNumber,
    activePlayer: player,
    phase: p.status === 'playing' ? 'harvest' : 'action',
    snailLostFight: false,
  };
  draft.turnMustEnd = false;
  pushEvent(draft, { type: 'turnStarted', player, turnNumber });

  // "Until your next turn" effects cast by this player expire now.
  const expired = draft.timedEffects.filter((e) => e.caster === player);
  if (expired.length > 0) {
    draft.timedEffects = draft.timedEffects.filter((e) => e.caster !== player);
    for (const e of expired) {
      pushEvent(draft, { type: 'timedEffectExpired', kind: e.kind, player });
    }
  }

  if (draft.turn.phase === 'action') {
    // Snail turns have no Harvest Phase.
    pushEvent(draft, { type: 'actionPhaseStarted', player });
    return;
  }

  // Magic Drain curse: starting your turn at 0 Wishes costs a gnome (if you
  // have one). The Harvest Phase itself is built lazily by the settle loop
  // (continueHarvest), so this sacrifice resolves before any harvest.
  if (curseActive(draft, CURSE_MAGIC_DRAIN) && p.wishes === 0) {
    const gnomes = playerUnits(draft, player)
      .filter((u) => u.kind === 'gnome')
      .map((u) => u.id);
    if (gnomes.length > 0) {
      draft.pendingDecision = { kind: 'sacrificeGnome', player, options: gnomes };
    }
  }
}

function doEndTurn(draft: GameState, player: PlayerId): void {
  requireActionPhaseActor(draft, player);
  const antsy = antsyPantsViolators(draft, player);
  if (antsy.length > 0) {
    illegal(
      `Antsy Pants: ${antsy.length} of your gnome(s) can still move this turn and must do so before it ends`,
    );
  }
  endTurnInternal(draft);
}

/**
 * Legal destinations for a unit's own 1-space move: orthogonal, on-board,
 * not behind the Great Wall, exit not locked (Lost In The Maize) and the
 * maize exit cost payable. Single source of truth for doMove validation,
 * getLegalActions enumeration and the Antsy Pants check.
 */
function moveDestinations(state: GameState, unit: Unit): Pos[] {
  if (gnomeExitBlocked(state, unit) !== null) return [];
  if (maizeExitCost(state, unit.pos) > getPlayer(state, unit.owner).wishes) return [];
  return orthNeighbors(state, unit.pos).filter((q) => !entryBlockedByWall(state, q));
}

/** Antsy Pants curse: the player's unmoved gnomes that still have a legal move. */
function antsyPantsViolators(state: GameState, player: PlayerId): Unit[] {
  if (!curseActive(state, CURSE_ANTSY_PANTS)) return [];
  const t = state.turn;
  if (!t || t.phase !== 'action') return [];
  return playerUnits(state, player).filter(
    (u) => u.kind === 'gnome' && u.movedOnTurn !== t.number && moveDestinations(state, u).length > 0,
  );
}

function endTurnInternal(draft: GameState): void {
  const t = requireTurn(draft);
  const p = getPlayer(draft, t.activePlayer);
  pushEvent(draft, { type: 'turnEnded', player: p.id });

  // Snail: destroy the garden it occupies — unless its turn ended by losing
  // a fight (then nothing is destroyed).
  if (p.status === 'snail' && !t.snailLostFight) {
    const snail = playerUnits(draft, p.id).find((u) => u.kind === 'snail');
    if (snail && gardenAt(draft, snail.pos)) {
      destroyGarden(draft, snail.pos, 'snail');
    }
  }

  // Per-turn markers keyed to this player's turn expire now.
  for (const g of Object.values(draft.gardens)) {
    if (g.stunnedForPlayerTurn === p.id) g.stunnedForPlayerTurn = null;
    if (g.doubledForPlayerTurn === p.id) g.doubledForPlayerTurn = null;
  }

  draft.harvest = null;
  draft.turnMustEnd = false;
  draft.pendingDecision = null;

  // Next seat (clockwise) still in the game.
  const n = draft.players.length;
  let next: PlayerId | null = null;
  for (let i = 1; i <= n; i++) {
    const cand = (t.activePlayer + i) % n;
    const cp = draft.players[cand];
    if (cp.status === 'playing' || cp.status === 'snail') {
      next = cand;
      break;
    }
  }
  if (next === null) {
    finishGame(draft, null);
    return;
  }
  startTurn(draft, next, t.number + 1);
}

// ---------------------------------------------------------------------------
// Eliminations / win detection
// ---------------------------------------------------------------------------

function processNextElimination(draft: GameState): void {
  const e = draft.eliminationQueue[0];
  const p = getPlayer(draft, e.player);
  if (p.status !== 'playing') {
    draft.eliminationQueue.shift();
    return;
  }

  const stillPlaying = draft.players.filter(
    (pl) => pl.status === 'playing' && !draft.eliminationQueue.some((q) => q.player === pl.id),
  );

  if (stillPlaying.length <= 1) {
    // Last non-snail player standing wins immediately; pending eliminated
    // players do not get a snailify choice (there is no game left to play).
    for (const q of draft.eliminationQueue) {
      const qp = getPlayer(draft, q.player);
      if (qp.status !== 'playing') continue;
      pushEvent(draft, { type: 'playerEliminated', player: q.player, reason: q.reason });
      removePlayerAssets(draft, q.player);
      qp.status = 'out';
    }
    draft.eliminationQueue = [];
    finishGame(draft, stillPlaying.length === 1 ? stillPlaying[0].id : null);
    return;
  }

  draft.eliminationQueue.shift();
  pushEvent(draft, { type: 'playerEliminated', player: e.player, reason: e.reason });
  draft.pendingDecision = { kind: 'snailify', player: e.player };
}

function doSnailify(draft: GameState, player: PlayerId, accept: boolean): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'snailify') illegal('No snailify decision is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s decision, not player ${player}'s`);
  draft.pendingDecision = null;
  const p = getPlayer(draft, player);
  removePlayerAssets(draft, player);

  if (accept) {
    p.status = 'snail';
    const snail: Unit = {
      id: `u${draft.nextUnitId++}`,
      owner: player,
      kind: 'snail',
      pos: { ...p.homePos },
      movedOnTurn: null,
    };
    draft.units[snail.id] = snail;
    pushEvent(draft, { type: 'playerSnailified', player, pos: snail.pos });
    handleEntry(draft, snail.id); // fights vs whoever stands on the old home space
  } else {
    p.status = 'out';
    pushEvent(draft, { type: 'snailifyDeclined', player });
  }

  // If the eliminated player was mid-turn, their turn ends now.
  if (draft.turn && draft.turn.activePlayer === player) {
    draft.turnMustEnd = true;
  }
}

/** Magic Drain curse: resolve the turn-start gnome sacrifice. */
function doSacrificeGnome(draft: GameState, player: PlayerId, unitId: string): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'sacrificeGnome') illegal('No gnome sacrifice is pending');
  if (d.player !== player) illegal(`It is player ${d.player}'s sacrifice, not player ${player}'s`);
  if (!d.options.includes(unitId)) badArg(`${unitId} is not one of your sacrificeable gnomes`);
  draft.pendingDecision = null;
  destroyUnit(draft, unitId, 'magic-drain');
}

/** Discard wishes + hand, remove all units and the Home Garden. */
function removePlayerAssets(draft: GameState, player: PlayerId): void {
  const p = getPlayer(draft, player);
  p.wishes = 0;
  for (const cardId of p.hand) draft.discard.push(cardId);
  p.hand = [];
  for (const u of playerUnits(draft, player)) {
    delete draft.units[u.id];
    // Removal, not destruction: partners survive, but the marriage dissolves.
    dissolveMarriages(draft, u.id);
    pushEvent(draft, { type: 'unitDestroyed', player, unitId: u.id, pos: u.pos, cause: 'elimination' });
  }
  const home = gardenAt(draft, p.homePos);
  if (home && home.type === 'home' && home.owner === player) {
    destroyGarden(draft, p.homePos, 'elimination');
  }
}

function finishGame(draft: GameState, winner: PlayerId | null): void {
  draft.status = 'finished';
  draft.winner = winner;
  draft.pendingDecision = null;
  draft.fight = null;
  draft.fightQueue = [];
  draft.harvest = null;
  pushEvent(draft, { type: 'gameFinished', winner });
}

// ---------------------------------------------------------------------------
// Action Phase actions
// ---------------------------------------------------------------------------

function requireActionPhaseActor(draft: GameState, player: PlayerId): void {
  if (draft.status !== 'playing') illegal('The game has not started yet (turn-order roll-off pending)');
  if (draft.pendingDecision) {
    illegal(`A "${draft.pendingDecision.kind}" decision by player ${draft.pendingDecision.player} must be resolved first`);
  }
  const t = requireTurn(draft);
  if (t.activePlayer !== player) illegal(`It is player ${t.activePlayer}'s turn, not player ${player}'s`);
  if (t.phase !== 'action') illegal('Not in the Action Phase (resolve harvests first)');
}

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

// ---------------------------------------------------------------------------
// Legal action enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate every legal action for `player` (default: the player who must
 * act — see getPlayerToAct). For a non-active player with no pending decision
 * this returns only their playable Sudden Magic interrupts.
 *
 * Note: playCard/respondPlayCard actions are enumerated WITHOUT targets —
 * targeted cards additionally need a `targets` payload satisfying the card's
 * `validate` (see cards.ts). Everything else is dispatchable as returned.
 */
export function getLegalActions(state: GameState, player?: PlayerId): Action[] {
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

// ---------------------------------------------------------------------------
// Misc public helpers
// ---------------------------------------------------------------------------

/** Convenience: number of gnomes `player` currently has on the board. */
export function boardGnomes(state: GameState, player: PlayerId): number {
  return gnomesOnBoard(state, player);
}
