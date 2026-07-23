/**
 * Fight resolution — the 3 R's (Respond, Roll, Resolve).
 *
 * Fights are stored on the draft (`draft.fight` + `draft.fightQueue`) and
 * progressed by the engine's settle loop. Stack fights (multiple gnomes per
 * side) loop 1v1 rounds — a full Respond → Roll → Resolve each round — until
 * only one side's critters remain on the space.
 *
 * Respond windows: sides[0] (defender) first, then sides[1] (attacker).
 * A window is auto-passed when its side is the flytrap or when the player has
 * no playable sudden-magic cards. Playing a card goes through the card stack
 * (cards.ts), so it can itself be countered by Nope-Gnome; it resets the pass
 * count, re-opening the opponent's window.
 *
 * Rolls: player sides roll via rollPlayerD6 (Snake Eyes / 4 Leaf Clover
 * modifiers apply and are consumed); the flytrap's die is a system roll.
 * Ties reroll — unless the Mulch Fever curse is active, in which case the
 * attacker (sides[1]) wins outright.
 *
 * Instigation fights are "pinned": each side is one specific gnome fighting
 * without moving; presence and destruction use the pinned units.
 */

import type {
  CardId,
  CardTargets,
  FightSide,
  FightState,
  GameState,
  PlayerId,
  QueuedFight,
  Unit,
} from './types';
import {
  CURSE_MULCH_FEVER,
  checkHomeCapture,
  curseActive,
  destroyUnit,
  draftRollD6,
  gardenAt,
  gardenIsActive,
  illegal,
  internal,
  playerUnitsAt,
  pushEvent,
  rollPlayerD6,
  samePos,
} from './helpers';
import { playCardFromHand, playableFightRespondCards } from './cards';

// ---------------------------------------------------------------------------
// Queueing / starting
// ---------------------------------------------------------------------------

export function queueFight(draft: GameState, fight: QueuedFight): void {
  draft.fightQueue.push(fight);
}

/** Does side `idx` of the fight still have a critter to fight with? */
function sideHasPresence(draft: GameState, fight: QueuedFight | FightState, idx: 0 | 1): boolean {
  const side = fight.sides[idx];
  if (fight.pinned) {
    const u = draft.units[fight.pinned[idx]];
    return !!u && side.kind === 'player' && u.owner === side.player;
  }
  if (side.kind === 'flytrap') {
    const g = gardenAt(draft, fight.pos);
    return !!g && g.type === 'flytrap' && gardenIsActive(draft, g) && g.stunnedForPlayerTurn === null;
  }
  return playerUnitsAt(draft, fight.pos, side.player).length > 0;
}

function fightStillValid(draft: GameState, q: QueuedFight): boolean {
  if (!sideHasPresence(draft, q, 0) || !sideHasPresence(draft, q, 1)) return false;
  if (q.targetUnit !== null) {
    const u = draft.units[q.targetUnit];
    if (!u || !samePos(u.pos, q.pos)) return false;
  }
  return true;
}

/**
 * Pop queued fights until one is still valid and make it the live fight.
 * Returns true if a fight was started.
 */
export function startNextQueuedFight(draft: GameState): boolean {
  while (draft.fightQueue.length > 0) {
    const q = draft.fightQueue.shift() as QueuedFight;
    if (!fightStillValid(draft, q)) continue;
    draft.fight = {
      id: draft.nextFightId++,
      pos: q.pos,
      sides: q.sides,
      targetUnit: q.targetUnit,
      pinned: q.pinned,
      cause: q.cause,
      round: 1,
      respondIdx: 0,
      passes: 0,
    };
    pushEvent(draft, {
      type: 'fightStarted',
      fightId: draft.fight.id,
      pos: q.pos,
      sides: q.sides,
      cause: q.cause,
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Progression (called from the settle loop)
// ---------------------------------------------------------------------------

/**
 * Advance the live fight: auto-pass empty Respond windows, surface a
 * fightRespond decision when a player has playable cards, otherwise roll and
 * resolve one round. Leaves either a pendingDecision, a new round on
 * `draft.fight`, or `draft.fight === null` (fight over).
 */
export function progressFight(draft: GameState): void {
  const f = draft.fight;
  if (!f) internal('progressFight without a live fight');

  // A side may have vanished mid-Respond (e.g. a responded card destroyed it).
  if (!sideHasPresence(draft, f, 0) || !sideHasPresence(draft, f, 1)) {
    endFight(draft, f);
    return;
  }

  // Respond windows.
  while (f.passes < 2) {
    const side = f.sides[f.respondIdx];
    if (side.kind === 'player') {
      const playable = playableFightRespondCards(draft, side.player);
      if (playable.length > 0) {
        draft.pendingDecision = {
          kind: 'fightRespond',
          player: side.player,
          fightId: f.id,
          playableCards: playable,
        };
        return;
      }
    }
    f.passes += 1;
    f.respondIdx = f.respondIdx === 0 ? 1 : 0;
  }

  rollAndResolveRound(draft, f);
}

export function handleRespondPass(draft: GameState, player: PlayerId): void {
  const f = requireRespond(draft, player);
  draft.pendingDecision = null;
  f.passes += 1;
  f.respondIdx = f.respondIdx === 0 ? 1 : 0;
}

/**
 * Play a Sudden Magic card inside a fight Respond window. The play goes
 * through the card stack (other players may respond / Nope it); the fight
 * waits until the stack resolves, then the Respond windows re-open.
 */
export function handleRespondPlayCard(
  draft: GameState,
  player: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
): void {
  requireRespond(draft, player);
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'fightRespond') internal('respond decision vanished');
  if (!d.playableCards.includes(cardId)) {
    illegal(`Card ${cardId} is not playable in this Respond window`);
  }
  commitFightRespondPlay(draft, player, cardId, targets);
}

/**
 * Commit a fight-response play: close the window, re-open the opponent's, and
 * push the card onto the stack. Shared by the immediate path (above) and the
 * completion of phased targeting (targeting.ts), so both flip the fight the
 * same way. Reads the live fight directly — the fightRespond decision may
 * already have been replaced by a cardTargeting one during targeting.
 */
export function commitFightRespondPlay(
  draft: GameState,
  player: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
): void {
  const f = draft.fight;
  if (!f) internal('no live fight to respond to');
  draft.pendingDecision = null;
  // A played card re-opens the opponent's window.
  f.passes = 0;
  f.respondIdx = f.respondIdx === 0 ? 1 : 0;
  playCardFromHand(draft, player, cardId, targets);
}

function requireRespond(draft: GameState, player: PlayerId): FightState {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'fightRespond') illegal('No fight Respond window is open');
  if (d.player !== player) illegal(`It is player ${d.player}'s Respond window, not player ${player}'s`);
  const f = draft.fight;
  if (!f || f.id !== d.fightId) internal('Respond decision does not match the live fight');
  return f;
}

// ---------------------------------------------------------------------------
// Roll + Resolve
// ---------------------------------------------------------------------------

function rollSide(draft: GameState, side: FightSide): number {
  return side.kind === 'player' ? rollPlayerD6(draft, side.player) : draftRollD6(draft);
}

function rollAndResolveRound(draft: GameState, f: FightState): void {
  // Roll. Ties reroll — unless Mulch Fever makes the attacker win outright.
  const mulchFever = curseActive(draft, CURSE_MULCH_FEVER);
  let a = rollSide(draft, f.sides[0]);
  let b = rollSide(draft, f.sides[1]);
  pushEvent(draft, { type: 'fightRolled', fightId: f.id, round: f.round, rolls: [a, b], tie: a === b });
  while (a === b && !mulchFever) {
    a = rollSide(draft, f.sides[0]);
    b = rollSide(draft, f.sides[1]);
    pushEvent(draft, { type: 'fightRolled', fightId: f.id, round: f.round, rolls: [a, b], tie: a === b });
  }

  // Mulch Fever tie: the attacker (sides[1]) wins ⇒ defender (sides[0]) loses.
  const loserIdx: 0 | 1 = a === b ? 0 : a < b ? 0 : 1;
  const loser = f.sides[loserIdx];
  const winner = f.sides[loserIdx === 0 ? 1 : 0];

  if (loser.kind === 'flytrap') {
    // Flytraps are never destroyed by fighting: stunned until the end of the
    // winning player's turn; any queued flytrap fights at this space cancel.
    const g = gardenAt(draft, f.pos);
    if (g && g.type === 'flytrap' && winner.kind === 'player') {
      g.stunnedForPlayerTurn = winner.player;
      pushEvent(draft, { type: 'flytrapStunned', pos: f.pos, untilEndOfTurnOf: winner.player });
      draft.fightQueue = draft.fightQueue.filter(
        (q) => !(samePos(q.pos, f.pos) && (q.sides[0].kind === 'flytrap' || q.sides[1].kind === 'flytrap')),
      );
    }
    endFight(draft, f);
    return;
  }

  // Losing side is a player: find their critters in this fight.
  const losers: Unit[] = f.pinned
    ? [draft.units[f.pinned[loserIdx]]].filter((u): u is Unit => !!u)
    : playerUnitsAt(draft, f.pos, loser.player);
  if (losers.length === 0) internal('Losing side has no critters in the fight');

  const losingSnail = losers.find((u) => u.kind === 'snail');
  if (losingSnail && losers.every((u) => u.kind === 'snail')) {
    // Immortal Snail loses: not destroyed, nothing else is destroyed. If it is
    // the snail's own turn, that turn ends immediately (and its end-of-turn
    // garden destruction is skipped).
    pushEvent(draft, { type: 'snailSurvivedLoss', player: loser.player, pos: f.pos });
    if (draft.turn && draft.turn.activePlayer === loser.player) {
      draft.turn.snailLostFight = true;
      draft.turnMustEnd = true;
    }
    endFight(draft, f);
    return;
  }

  // Destroy one losing gnome (the fight's pinned/target unit if it belongs to
  // the losing side, otherwise the lowest-id gnome for determinism). Note the
  // destruction can be prevented by Gnomebody Dies — the round still ends.
  let victim: Unit | undefined;
  if (f.pinned) {
    victim = losers[0];
  } else if (f.targetUnit !== null) {
    const t = draft.units[f.targetUnit];
    if (t && t.owner === loser.player && samePos(t.pos, f.pos) && t.kind === 'gnome') victim = t;
  }
  if (!victim) victim = losers.find((u) => u.kind === 'gnome');
  if (!victim) internal('No gnome to destroy on the losing side');
  const destroyed = destroyUnit(draft, victim.id, 'fight');

  // Pinned (Instigation) fights end after one decisive round.
  if (f.pinned && destroyed) {
    endFight(draft, f);
    return;
  }

  // Flytrap fights are 1v1 vs the target; a flytrap win ends the fight
  // (even a prevented destruction — the flytrap has had its bite).
  if (winner.kind === 'flytrap') {
    endFight(draft, f);
    return;
  }

  // Stack fight: another round while both sides still have critters here.
  if (sideHasPresence(draft, f, 0) && sideHasPresence(draft, f, 1)) {
    f.round += 1;
    f.passes = 0;
    f.respondIdx = 0;
    pushEvent(draft, { type: 'fightRoundStarted', fightId: f.id, round: f.round });
    return;
  }

  endFight(draft, f);
}

function endFight(draft: GameState, f: FightState): void {
  draft.fight = null;
  pushEvent(draft, { type: 'fightEnded', fightId: f.id, pos: f.pos });
  // [RULING] Elimination check runs after all fights on the space resolve.
  checkHomeCapture(draft, f.pos);
}
