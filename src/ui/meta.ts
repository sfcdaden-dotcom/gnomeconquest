/**
 * UI metadata + human-readable formatting.
 * Pure functions over engine data — no rule logic lives here.
 */

import type { Action, CardTarget, FightSide, GameEvent, GameState, GardenType, Pos } from '../engine';
import { getCardDef, getCurseDef } from '../engine';

// ---------------------------------------------------------------------------
// Player + garden presentation
// ---------------------------------------------------------------------------

/** Seat colors: red, blue, gold, purple (clockwise). */
export const PLAYER_COLORS = ['#d8504d', '#3f7ad8', '#c9930a', '#9256cf'];
export const PLAYER_COLOR_NAMES = ['Red', 'Blue', 'Gold', 'Purple'];

export function playerColor(id: number): string {
  return PLAYER_COLORS[id % PLAYER_COLORS.length];
}

/** A fresh random game seed (UI convenience; the engine itself never rolls). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

export interface GardenMeta {
  emoji: string;
  label: string;
  blurb: string;
}

export const GARDEN_META: Record<GardenType, GardenMeta> = {
  home: { emoji: '🏡', label: 'Home Garden', blurb: 'Harvest: 1 Wish or 1 Gnome. Lose it, lose the game.' },
  dandelion: { emoji: '🌼', label: 'Dandelion', blurb: 'Harvest: up to 2 occupying gnomes gain 1 Wish each.' },
  mushroom: { emoji: '🍄', label: 'Mushroom', blurb: 'Harvest: clone up to 2 occupying gnomes.' },
  flytrap: { emoji: '🪤', label: 'Flytrap', blurb: 'Neutral hazard: fights anyone who enters or harvests here.' },
  maize: { emoji: '🌽', label: 'Maize', blurb: 'Exit costs 1 Wish. Harvest roll < 4 doubles the cost.' },
  slippery: { emoji: '🧊', label: 'Slippery', blurb: 'Entry: slide 1 space. Harvest: slide anywhere adjacent (incl. diagonal).' },
  tunnel: { emoji: '🕳️', label: 'Tunnel', blurb: 'Entry: hop to another tunnel. Harvest: tunnel or hop to a garden you occupy.' },
};

export const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export function dieFace(roll: number): string {
  return DIE_FACES[Math.max(0, Math.min(5, roll - 1))];
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export function pname(state: GameState, id: number): string {
  return state.players[id]?.name ?? `Player ${id + 1}`;
}

export function cardName(id: string): string {
  return getCardDef(id)?.name ?? getCurseDef(id)?.name ?? id;
}

export function sideName(state: GameState, side: FightSide): string {
  return side.kind === 'flytrap' ? 'the Flytrap' : pname(state, side.player);
}

export function posStr(p: Pos): string {
  return `(${p.x},${p.y})`;
}

// ---------------------------------------------------------------------------
// Event → sentence
// ---------------------------------------------------------------------------

export function describeEvent(state: GameState, ev: GameEvent): string {
  switch (ev.type) {
    case 'rollOffRolled':
      return `${pname(state, ev.player)} rolls ${dieFace(ev.roll)} ${ev.roll} for turn order.`;
    case 'rollOffTie':
      return `Tie! ${ev.players.map((p) => pname(state, p)).join(' and ')} reroll.`;
    case 'turnOrderDetermined':
      return `${pname(state, ev.first)} goes first!`;
    case 'turnStarted':
      return `— Turn ${ev.turnNumber}: ${pname(state, ev.player)} —`;
    case 'harvestPhaseStarted':
      return `${pname(state, ev.player)}'s Harvest Phase (${ev.sources.length} source${ev.sources.length === 1 ? '' : 's'}).`;
    case 'actionPhaseStarted':
      return `${pname(state, ev.player)}'s Action Phase.`;
    case 'harvestSkipped':
      return `Harvest ${ev.sourceKey} skipped (${ev.reason}).`;
    case 'homeHarvested':
      return ev.took === 'nothing'
        ? `${pname(state, ev.player)}'s Home Garden produces nothing (limits reached).`
        : `${pname(state, ev.player)}'s Home Garden grants a ${ev.took === 'wish' ? 'Wish ✨' : 'Gnome'}.`;
    case 'dandelionHarvested':
      return `${pname(state, ev.player)}'s Dandelion at ${posStr(ev.pos)} blooms for ${ev.gnomes} gnome${ev.gnomes === 1 ? '' : 's'}.`;
    case 'mushroomHarvested':
      return `${pname(state, ev.player)}'s Mushroom at ${posStr(ev.pos)} clones ${ev.cloned} gnome${ev.cloned === 1 ? '' : 's'}.`;
    case 'maizeHarvested':
      return `${pname(state, ev.player)} rolls ${ev.roll} at the Maize ${posStr(ev.pos)}${ev.doubled ? ' — exit cost doubled!' : '.'}`;
    case 'wishesGained':
      return `${pname(state, ev.player)} gains ${ev.gained} Wish${ev.gained === 1 ? '' : 'es'}${ev.lost > 0 ? ` (${ev.lost} lost to the cap)` : ''}.`;
    case 'wishesSpent':
      return `${pname(state, ev.player)} spends ${ev.amount} Wish${ev.amount === 1 ? '' : 'es'} (${ev.reason}).`;
    case 'gnomeSpawned':
      return `A gnome for ${pname(state, ev.player)} appears at ${posStr(ev.pos)}.`;
    case 'unitMoved':
      return `${pname(state, ev.player)} moves ${posStr(ev.from)} → ${posStr(ev.to)}.`;
    case 'unitSlid':
      return `${pname(state, ev.player)}'s gnome slides ${posStr(ev.from)} → ${posStr(ev.to)}.`;
    case 'unitTunneled':
      return `${pname(state, ev.player)}'s gnome tunnels ${posStr(ev.from)} → ${posStr(ev.to)}.`;
    case 'entryEffectDeclined':
      return `${pname(state, ev.player)} declines the entry effect at ${posStr(ev.pos)}.`;
    case 'gardenPlanted':
      return `${pname(state, ev.player)} plants a ${GARDEN_META[ev.gardenType].label} ${GARDEN_META[ev.gardenType].emoji} at ${posStr(ev.pos)}.`;
    case 'gardenDestroyed':
      return `The ${GARDEN_META[ev.gardenType].label} at ${posStr(ev.pos)} is destroyed (${ev.cause}).`;
    case 'maizeExitPaid':
      return `${pname(state, ev.player)} pays ${ev.cost} Wish to leave the Maize at ${posStr(ev.pos)}.`;
    case 'cardDrawn':
      return `${pname(state, ev.player)} draws a Whimsy card.`; // identity hidden (pass-and-play)
    case 'cardDiscarded':
      return `${pname(state, ev.player)} discards ${cardName(ev.cardId)}.`;
    case 'cardPlayed':
      return `${pname(state, ev.player)} plays ${cardName(ev.cardId)}!`;
    case 'cardResolved':
      return `${pname(state, ev.player)}'s ${cardName(ev.cardId)} resolves.`;
    case 'cardCancelled':
      return `🚫 ${pname(state, ev.player)}'s ${cardName(ev.cardId)} is cancelled!`;
    case 'cardFizzled':
      return `${pname(state, ev.player)}'s ${cardName(ev.cardId)} fizzles (${ev.reason}).`;
    case 'cardStolen':
      return `${pname(state, ev.to)} steals a random card from ${pname(state, ev.from)}.`;
    case 'rollModified':
      return `${pname(state, ev.player)}'s roll is modified: ${ev.raw} ${ev.modifier >= 0 ? '+' : '−'} ${Math.abs(ev.modifier)} → ${ev.result}.`;
    case 'destructionPrevented':
      return `🛡️ ${pname(state, ev.player)}'s gnome is saved (Gnomebody Dies)!`;
    case 'gnomesMarried':
      return '💍 Two gnomes are married — till death do them join.';
    case 'unitTeleported':
      return `${pname(state, ev.player)}'s gnome moves ${posStr(ev.from)} → ${posStr(ev.to)} (${cardName(ev.cardId)}).`;
    case 'spacesSwapped':
      return `🔀 Plot Twist! ${posStr(ev.a)} and ${posStr(ev.b)} swap contents.`;
    case 'timedEffectStarted':
      return ev.kind === 'greatWall'
        ? `🚧 Great Wall Of Whimsy${ev.pos ? ` at ${posStr(ev.pos)}` : ''} — no entry until ${pname(state, ev.player)}'s next turn.`
        : `🌽 Lost In The Maize — gnomes can't leave Maize Gardens until ${pname(state, ev.player)}'s next turn.`;
    case 'timedEffectExpired':
      return `${ev.kind === 'greatWall' ? 'The Great Wall Of Whimsy' : 'Lost In The Maize'} expires.`;
    case 'curseRevealed':
      return `☠️ ${pname(state, ev.player)} reveals a Curse: ${cardName(ev.cardId)}! It affects everyone, forever.`;
    case 'deckReshuffled':
      return `The deck is reshuffled${ev.curseAdded ? ' — a Curse lurks within…' : '.'}`;
    case 'fightStarted':
      return `⚔️ Fight at ${posStr(ev.pos)}: ${sideName(state, ev.sides[1])} attacks ${sideName(state, ev.sides[0])}!`;
    case 'fightRoundStarted':
      return `⚔️ Round ${ev.round}…`;
    case 'fightRolled':
      return `Rolls: ${dieFace(ev.rolls[0])} ${ev.rolls[0]} vs ${dieFace(ev.rolls[1])} ${ev.rolls[1]}${ev.tie ? ' — tie, reroll!' : ''}`;
    case 'unitDestroyed':
      return `${pname(state, ev.player)} loses a unit at ${posStr(ev.pos)} (${ev.cause}).`;
    case 'flytrapStunned':
      return `The Flytrap at ${posStr(ev.pos)} is stunned!`;
    case 'snailSurvivedLoss':
      return `${pname(state, ev.player)}'s Immortal Snail shrugs off the loss.`;
    case 'fightEnded':
      return `The fight at ${posStr(ev.pos)} ends.`;
    case 'playerEliminated':
      return `💀 ${pname(state, ev.player)} is eliminated (${ev.reason === 'home-captured' ? 'home garden captured' : 'out of reinforcements'}).`;
    case 'playerSnailified':
      return `🐌 ${pname(state, ev.player)} returns as an Immortal Snail at ${posStr(ev.pos)}!`;
    case 'snailifyDeclined':
      return `${pname(state, ev.player)} leaves the game.`;
    case 'turnEnded':
      return `${pname(state, ev.player)} ends their turn.`;
    case 'gameFinished':
      return ev.winner !== null
        ? `🏆 ${pname(state, ev.winner)} wins Whimsy Wars!`
        : 'Nobody wins — the garden falls silent.';
    default: {
      // Future event kinds (cards in progress): render something readable.
      const e = ev as { type: string };
      return `${e.type}: ${JSON.stringify(ev)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Action → button label (generic fallback for unknown decision kinds)
// ---------------------------------------------------------------------------

export function describeAction(state: GameState, a: Action): string {
  switch (a.type) {
    case 'rollOff':
      return '🎲 Roll the die';
    case 'chooseHarvest':
      return `Harvest ${a.sourceKey === 'home' ? 'Home Garden' : `garden at (${a.sourceKey})`}`;
    case 'homeHarvest':
      return a.take === 'wish' ? '✨ Take 1 Wish' : '🧙 Spawn a Gnome';
    case 'mushroomClones':
      return `Clone ${a.count} gnome${a.count === 1 ? '' : 's'}`;
    case 'slide':
      return `Slide to ${posStr(a.to)}`;
    case 'tunnel':
      return `Tunnel to ${posStr(a.to)}`;
    case 'declineEffect':
      return 'Decline';
    case 'respondPass':
      return 'Pass';
    case 'respondPlayCard':
      return `Play ${cardName(a.cardId)}`;
    case 'discardCard':
      return `Discard ${cardName(a.cardId)}`;
    case 'snailify':
      return a.accept ? '🐌 Become the Immortal Snail' : 'Leave the game';
    case 'sacrificeGnome': {
      const u = state.units[a.unitId];
      return `Sacrifice the gnome at ${u ? posStr(u.pos) : a.unitId}`;
    }
    case 'snailMove':
      return `Move the snail to ${posStr(a.to)}`;
    case 'selectTarget':
      return describeTarget(state, a.target);
    case 'cancelTargeting':
      return 'Cancel targeting';
    case 'move':
      return `Move to ${posStr(a.to)}`;
    case 'plant':
      return `Plant ${GARDEN_META[a.gardenType].label} at ${posStr(a.pos)}`;
    case 'drawCard':
      return 'Draw a card (1 ✨)';
    case 'playCard':
      return `Play ${cardName(a.cardId)}`;
    case 'endTurn':
      return 'End turn';
    default: {
      // Future action kinds added by the card system.
      const raw = a as { type: string };
      const rest = Object.entries(a as Record<string, unknown>)
        .filter(([k]) => k !== 'type' && k !== 'player')
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      return rest ? `${raw.type} (${rest})` : raw.type;
    }
  }
}

function describeTarget(state: GameState, target: CardTarget): string {
  switch (target.kind) {
    case 'unit': {
      const u = state.units[target.unitId];
      return `Target the unit at ${u ? posStr(u.pos) : target.unitId}`;
    }
    case 'space':
      return `Target ${posStr(target.pos)}`;
    case 'player':
      return `Target ${pname(state, target.playerId)}`;
    case 'card':
      return `Choose ${cardName(target.cardId)}`;
    case 'gardenType':
      return `Choose ${GARDEN_META[target.gardenType].label}`;
  }
}

export function decisionLabel(kind: string): string {
  switch (kind) {
    case 'rollOff':
      return 'turn-order roll';
    case 'chooseHarvest':
      return 'choose harvest order';
    case 'homeHarvest':
      return 'home harvest';
    case 'mushroomClones':
      return 'mushroom clones';
    case 'slide':
      return 'slide destination';
    case 'tunnel':
      return 'tunnel destination';
    case 'fightRespond':
      return 'fight response';
    case 'cardResponse':
      return 'card response window';
    case 'cardTargeting':
      return 'choosing targets';
    case 'sacrificeGnome':
      return 'sacrifice a gnome';
    case 'snailMove':
      return 'snail move';
    case 'discard':
      return 'discard to hand limit';
    case 'snailify':
      return 'elimination choice';
    default:
      return kind;
  }
}
