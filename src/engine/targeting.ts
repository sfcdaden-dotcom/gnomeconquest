/**
 * Phased card targeting.
 *
 * Instead of expanding every complete `CardTargets` payload up front, the
 * engine walks a card's ordered targeting flow (see `TargetStep` in cards.ts)
 * one step at a time. A play that arrives WITHOUT targets opens a
 * `cardTargeting` decision; each `selectTarget` folds one pick in and either
 * advances to the next step or — on the last step — re-validates the complete
 * payload and commits the card. `cancelTargeting` backs out with no side
 * effects, because the card was never removed from hand (playing a card is
 * free, so there is nothing to refund).
 *
 * The current step's options are always recomputed from live state
 * (`getPendingDecisionOptions`), never stored on the decision, so they cannot
 * go stale across a save/load or an intervening state change.
 *
 * This module is the single owner of the `cardTargeting` transaction. cards.ts
 * and fights.ts expose the low-level commit helpers it calls on completion but
 * never import it back, so the dependency graph stays acyclic:
 *   targeting → {cards, fights} → helpers.
 */

import type {
  CardId,
  CardTarget,
  CardTargets,
  GameState,
  PendingDecision,
  PlayerId,
  TargetKind,
} from './types';
import { badArg, illegal, internal, posKey, samePos } from './helpers';
import { commitCardResponsePlay, getCardDef, playCardFromHand } from './cards';
import type { TargetStep } from './cards';
import { commitFightRespondPlay } from './fights';

type TargetingDecision = Extract<PendingDecision, { kind: 'cardTargeting' }>;
type RestoreWindow = TargetingDecision['restore'];

// ---------------------------------------------------------------------------
// Flow access & payload folding
// ---------------------------------------------------------------------------

/** The card's targeting flow for the current state (empty for untargeted cards). */
function cardFlow(state: GameState, cardId: CardId, player: PlayerId): TargetStep[] {
  const def = getCardDef(cardId);
  return def?.targetFlow ? def.targetFlow(state, player) : [];
}

/** Fold one chosen target into the accumulating CardTargets payload (immutably). */
function foldTarget(selected: CardTargets, t: CardTarget): CardTargets {
  const next: CardTargets = structuredClone(selected);
  switch (t.kind) {
    case 'unit':
      (next.units ??= []).push(t.unitId);
      break;
    case 'space':
      (next.spaces ??= []).push({ x: t.pos.x, y: t.pos.y });
      break;
    case 'player':
      (next.players ??= []).push(t.playerId);
      break;
    case 'card':
      (next.cards ??= []).push(t.cardId);
      break;
    case 'gardenType':
      next.gardenType = t.gardenType;
      break;
  }
  return next;
}

function targetsEqual(a: CardTarget, b: CardTarget): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'unit':
      return a.unitId === (b as Extract<CardTarget, { kind: 'unit' }>).unitId;
    case 'space':
      return samePos(a.pos, (b as Extract<CardTarget, { kind: 'space' }>).pos);
    case 'player':
      return a.playerId === (b as Extract<CardTarget, { kind: 'player' }>).playerId;
    case 'card':
      return a.cardId === (b as Extract<CardTarget, { kind: 'card' }>).cardId;
    case 'gardenType':
      return a.gardenType === (b as Extract<CardTarget, { kind: 'gardenType' }>).gardenType;
  }
}

// ---------------------------------------------------------------------------
// Reading the current step
// ---------------------------------------------------------------------------

/**
 * Legal options for the step the current `cardTargeting` decision is on. Empty
 * when no such decision is pending. Recomputed from live state every call, so a
 * consumer can trust it even after the state changed under a saved decision.
 */
export function getPendingDecisionOptions(state: GameState): CardTarget[] {
  const d = state.pendingDecision;
  if (!d || d.kind !== 'cardTargeting') return [];
  return currentStepOptions(state, d);
}

function currentStepOptions(state: GameState, d: TargetingDecision): CardTarget[] {
  const step = cardFlow(state, d.cardId, d.player)[d.stepIndex];
  return step ? step.getOptions(state, { player: d.player, selected: d.selected }) : [];
}

/**
 * Build the `cardTargeting` decision for one step, or null when that step has
 * no legal option (so the caller can report "no legal targets").
 */
function makeTargetingDecision(
  state: GameState,
  player: PlayerId,
  cardId: CardId,
  selected: CardTargets,
  stepIndex: number,
  flow: TargetStep[],
  restore: RestoreWindow,
): TargetingDecision | null {
  const step = flow[stepIndex];
  if (!step) internal('targeting step index out of range');
  const options = step.getOptions(state, { player, selected });
  if (options.length === 0) return null;
  const decision: TargetingDecision = {
    kind: 'cardTargeting',
    player,
    cardId,
    selected,
    stepIndex,
    stepCount: flow.length,
    targetKind: step.kind,
    prompt: step.prompt,
  };
  if (restore) decision.restore = restore;
  return decision;
}

// ---------------------------------------------------------------------------
// Starting a targeting session
// ---------------------------------------------------------------------------

/** Begin phased targeting for a normal Action-Phase play. */
export function beginActionTargeting(draft: GameState, player: PlayerId, cardId: CardId): void {
  beginTargeting(draft, player, cardId, undefined);
}

/**
 * Begin phased targeting for a card played inside the currently-open response
 * window (fight or card). The window decision is stashed as `restore` so
 * cancellation puts it back exactly; completion routes through the matching
 * commit helper.
 */
export function beginResponseTargeting(draft: GameState, player: PlayerId, cardId: CardId): void {
  const d = draft.pendingDecision;
  if (!d || (d.kind !== 'cardResponse' && d.kind !== 'fightRespond')) {
    illegal('No response window is open');
  }
  if (d.player !== player) illegal(`It is player ${d.player}'s response window, not player ${player}'s`);
  if (!d.playableCards.includes(cardId)) {
    illegal(`Card ${cardId} is not playable in this response window`);
  }
  beginTargeting(draft, player, cardId, d);
}

function beginTargeting(draft: GameState, player: PlayerId, cardId: CardId, restore: RestoreWindow): void {
  const flow = cardFlow(draft, cardId, player);
  if (flow.length === 0) badArg(`Card ${cardId} does not take targets`);
  const decision = makeTargetingDecision(draft, player, cardId, {}, 0, flow, restore);
  if (decision === null) {
    illegal(`${getCardDef(cardId)?.name ?? cardId} has no legal targets right now`);
  }
  draft.pendingDecision = decision;
}

// ---------------------------------------------------------------------------
// Answering / cancelling
// ---------------------------------------------------------------------------

/** Choose one option for the current targeting step; advance or commit. */
export function applySelectTarget(draft: GameState, player: PlayerId, target: CardTarget): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'cardTargeting') illegal('No card targeting is in progress');
  if (d.player !== player) illegal(`It is player ${d.player}'s targeting, not player ${player}'s`);

  const options = currentStepOptions(draft, d);
  if (!options.some((o) => targetsEqual(o, target))) {
    // Stale UI, malformed AI/engine caller, or a target invalidated between
    // steps: reject rather than silently accept an out-of-set pick.
    badArg('That target is not a legal option for the current targeting step');
  }

  const selected = foldTarget(d.selected, target);
  const flow = cardFlow(draft, d.cardId, d.player);
  const nextIndex = d.stepIndex + 1;

  if (nextIndex < flow.length) {
    const next = makeTargetingDecision(draft, player, d.cardId, selected, nextIndex, flow, d.restore);
    // Honest step options guarantee at least one completion, so a later step
    // is never emptied by an earlier legal pick.
    if (next === null) internal('a legal targeting pick left the next step with no options');
    draft.pendingDecision = next;
    return;
  }

  finishTargeting(draft, d, selected);
}

/** Abandon the in-progress targeting, restoring whatever preceded it. */
export function applyCancelTargeting(draft: GameState, player: PlayerId): void {
  const d = draft.pendingDecision;
  if (!d || d.kind !== 'cardTargeting') illegal('No card targeting to cancel');
  if (d.player !== player) illegal(`It is player ${d.player}'s targeting, not player ${player}'s`);
  // The card never left the hand, so this is a clean rollback: reopen the
  // response window it came from, or return to the idle Action Phase.
  draft.pendingDecision = d.restore ?? null;
}

/** Last step done: re-validate the whole payload, then commit the play. */
function finishTargeting(draft: GameState, d: TargetingDecision, selected: CardTargets): void {
  const def = getCardDef(d.cardId);
  if (!def) badArg(`Unknown card: ${d.cardId}`);
  // The authoritative final check — guards against stale UI state, malformed
  // callers, and any change since the first step. Never trust the picks alone.
  if (def.validate) {
    const err = def.validate(draft, d.player, selected);
    if (err) illegal(`${def.name}: ${err}`);
  }
  const restore = d.restore;
  draft.pendingDecision = null;
  if (!restore) {
    playCardFromHand(draft, d.player, d.cardId, selected);
  } else if (restore.kind === 'cardResponse') {
    commitCardResponsePlay(draft, d.player, d.cardId, selected, restore.stackIndex);
  } else {
    commitFightRespondPlay(draft, d.player, d.cardId, selected);
  }
}

// ---------------------------------------------------------------------------
// Analysis helpers (NOT on the UI / normal-AI path)
// ---------------------------------------------------------------------------

/**
 * Every complete, valid `CardTargets` payload for a card, by walking its flow
 * depth-first (each step narrowed by the earlier picks). This is the phased
 * analogue of the old cartesian expansion — but because each step yields only
 * its own legal options, the work is proportional to the real branching (Plot
 * Twist: n·(n-1)/2 adjacent pairs), never C(area, k). There is no global
 * combination ceiling: phased narrowing keeps it bounded by construction.
 *
 * Expensive relative to a single step; used only by the complete-action
 * analysis helper (`enumerateCompleteCardActions`) and tests. The UI and AI
 * never call it.
 */
export function enumerateCardTargets(state: GameState, player: PlayerId, cardId: CardId): CardTargets[] {
  const def = getCardDef(cardId);
  if (!def?.needsTargets) return [];
  const flow = cardFlow(state, cardId, player);
  if (flow.length === 0) return [];

  const out: CardTargets[] = [];
  const seen = new Set<string>();
  const walk = (stepIndex: number, selected: CardTargets): void => {
    if (stepIndex >= flow.length) {
      if (def.validate && def.validate(state, player, selected) !== null) return;
      const key = canonicalKey(flow, selected);
      if (seen.has(key)) return; // drop reversed duplicates of unordered slots
      seen.add(key);
      out.push(selected);
      return;
    }
    for (const opt of flow[stepIndex].getOptions(state, { player, selected })) {
      walk(stepIndex + 1, foldTarget(selected, opt));
    }
  };
  walk(0, {});
  return out;
}

/**
 * Greedily pick the first option at every step, returning the completed payload
 * if it validates, else null. A cheap way to turn a bare card id into a legal
 * play — used as the AI's structural safety net for a card without a dedicated
 * planner (so it degrades to "play it with the first legal targets" rather than
 * emitting a half-built action).
 */
export function firstCompleteTargets(state: GameState, player: PlayerId, cardId: CardId): CardTargets | null {
  const flow = cardFlow(state, cardId, player);
  if (flow.length === 0) return null;
  let selected: CardTargets = {};
  for (const step of flow) {
    const opts = step.getOptions(state, { player, selected });
    if (opts.length === 0) return null;
    selected = foldTarget(selected, opts[0]);
  }
  const def = getCardDef(cardId);
  if (def?.validate && def.validate(state, player, selected) !== null) return null;
  return selected;
}

/**
 * Canonical signature for dedup: values of an UNORDERED slot are sorted (so
 * [a,b] and [b,a] collapse), while an ordered slot (Instigation) keeps its
 * order. A slot counts as ordered if any of its steps is flagged `ordered`.
 */
function canonicalKey(flow: TargetStep[], t: CardTargets): string {
  const ordered = new Set<TargetKind>();
  for (const s of flow) if (s.ordered) ordered.add(s.kind);
  const norm = (arr: string[], kind: TargetKind) => (ordered.has(kind) ? arr : [...arr].sort());
  return JSON.stringify({
    u: norm(t.units ?? [], 'unit'),
    s: norm((t.spaces ?? []).map(posKey), 'space'),
    p: norm((t.players ?? []).map(String), 'player'),
    c: norm(t.cards ?? [], 'card'),
    g: t.gardenType ?? null,
  });
}
