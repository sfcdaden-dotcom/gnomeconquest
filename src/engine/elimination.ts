/**
 * Eliminations, the Immortal Snail conversion and win detection.
 *
 * An eliminated player is queued (`state.eliminationQueue`) and processed by
 * the settle loop: they are offered the snailify choice unless the game is
 * already decided, in which case the last player standing wins immediately.
 */

import type { GameState, PlayerId, Unit } from './types';
import {
  badArg,
  destroyGarden,
  destroyUnit,
  dissolveMarriages,
  gardenAt,
  getPlayer,
  illegal,
  playerUnits,
  pushEvent,
} from './helpers';
import { handleEntry } from './gardens';

export function processNextElimination(draft: GameState): void {
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

export function doSnailify(draft: GameState, player: PlayerId, accept: boolean): void {
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
export function doSacrificeGnome(draft: GameState, player: PlayerId, unitId: string): void {
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

export function finishGame(draft: GameState, winner: PlayerId | null): void {
  draft.status = 'finished';
  draft.winner = winner;
  draft.pendingDecision = null;
  draft.fight = null;
  draft.fightQueue = [];
  draft.harvest = null;
  pushEvent(draft, { type: 'gameFinished', winner });
}
