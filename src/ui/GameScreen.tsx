/**
 * The game screen: board + panels + overlays, wired to the engine through
 * useGame. All legality flows from the engine — clicks are matched against
 * enumerated legal actions, and card targets are validated by each card's
 * own `validate` (the UI never recomputes rules).
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  Action,
  CardId,
  CardTargets,
  CreateGameOptions,
  GameState,
  PlantableGardenType,
  PlayerId,
  Pos,
  TargetSpec,
  UnitId,
} from '../engine';
import { getCardDef, getLegalActionIntents, getTargetOptions, posKey, samePos, unitsAt } from '../engine';
import { Board } from './Board';
import type { HighlightKind } from './Board';
import { DecisionPanel } from './DecisionPanel';
import { FightPanel, FightPlaybackOverlay, GameLog, HandPanel, PlayerPanels } from './panels';
import { GARDEN_META, cardName, decisionLabel, playerColor, pname } from './meta';
import { useGame } from './useGame';

// ---------------------------------------------------------------------------
// Selection / card-targeting state
// ---------------------------------------------------------------------------

interface TargetSel {
  kind: 'target';
  cardId: CardId;
  /** true ⇒ dispatch respondPlayCard (fight / card response window). */
  respond: boolean;
  player: PlayerId;
  spec: TargetSpec;
  units: UnitId[];
  spaces: Pos[];
  players: PlayerId[];
  cards: CardId[];
  gardenType?: PlantableGardenType;
}

type Sel = { kind: 'none' } | { kind: 'unit'; unitId: UnitId } | TargetSel;

const NO_SEL: Sel = { kind: 'none' };

function targetingComplete(t: TargetSel): boolean {
  return (
    (!t.spec.units || t.units.length >= t.spec.units.count) &&
    (!t.spec.spaces || t.spaces.length >= t.spec.spaces.count) &&
    (!t.spec.players || t.players.length >= t.spec.players.count) &&
    (!t.spec.cards || t.cards.length >= t.spec.cards.count) &&
    (!t.spec.gardenType || t.gardenType !== undefined)
  );
}

function anyTargetPicked(t: TargetSel): boolean {
  return (
    t.units.length > 0 ||
    t.spaces.length > 0 ||
    t.players.length > 0 ||
    t.cards.length > 0 ||
    t.gardenType !== undefined
  );
}

function buildTargets(t: TargetSel): CardTargets {
  const targets: CardTargets = {};
  if (t.units.length > 0) targets.units = t.units;
  if (t.spaces.length > 0) targets.spaces = t.spaces;
  if (t.players.length > 0) targets.players = t.players;
  if (t.cards.length > 0) targets.cards = t.cards;
  if (t.gardenType !== undefined) targets.gardenType = t.gardenType;
  return targets;
}

/** The intent behind a targeting session, for getTargetOptions. */
function targetIntent(t: TargetSel): Action {
  return t.respond
    ? { type: 'respondPlayCard', player: t.player, cardId: t.cardId }
    : { type: 'playCard', player: t.player, cardId: t.cardId };
}

// --- generic target-payload matching ---------------------------------------
// The engine enumerates every valid CardTargets payload for a card; the UI
// narrows that list against the picks made so far. Nothing here knows any
// card's rules — values are compared as opaque keys.

const SLOTS = ['units', 'spaces', 'players', 'cards', 'gardenType'] as const;
type SlotKey = (typeof SLOTS)[number];

function slotKeys(t: Pick<TargetSel, SlotKey>): Record<SlotKey, string[]> {
  return {
    units: t.units,
    spaces: t.spaces.map(posKey),
    players: t.players.map(String),
    cards: t.cards,
    gardenType: t.gardenType === undefined ? [] : [t.gardenType],
  };
}

function comboSlotKeys(c: CardTargets): Record<SlotKey, string[]> {
  return {
    units: c.units ?? [],
    spaces: (c.spaces ?? []).map(posKey),
    players: (c.players ?? []).map(String),
    cards: c.cards ?? [],
    gardenType: c.gardenType === undefined ? [] : [c.gardenType],
  };
}

/**
 * Remove `picked` from `available` (multiset difference), or null when a pick
 * is absent — i.e. this payload is not reachable from the current picks.
 */
function leftover(available: string[], picked: string[]): string[] | null {
  const rest = [...available];
  for (const k of picked) {
    const i = rest.indexOf(k);
    if (i < 0) return null;
    rest.splice(i, 1);
  }
  return rest;
}

/**
 * Can this enumerated payload still be reached from the picks made so far?
 * Picks are matched as a subset, not a prefix: for unordered slots the engine
 * emits one canonical order, and the player may click those targets in any
 * order.
 */
function comboReachable(combo: CardTargets, t: TargetSel): boolean {
  const picks = slotKeys(t);
  const avail = comboSlotKeys(combo);
  return SLOTS.every((s) => leftover(avail[s], picks[s]) !== null);
}

interface TargetCandidates {
  units: Set<string>;
  spaces: Set<string>;
  players: Set<number>;
  cards: Set<string>;
  gardenTypes: Set<PlantableGardenType>;
}

/** What the player may still click/press next, given the reachable payloads. */
function candidatesFrom(reachable: readonly CardTargets[], t: TargetSel): TargetCandidates {
  const out: TargetCandidates = {
    units: new Set(),
    spaces: new Set(),
    players: new Set(),
    cards: new Set(),
    gardenTypes: new Set(),
  };
  const picks = slotKeys(t);
  for (const combo of reachable) {
    const avail = comboSlotKeys(combo);
    for (const id of leftover(avail.units, picks.units) ?? []) out.units.add(id);
    for (const k of leftover(avail.spaces, picks.spaces) ?? []) out.spaces.add(k);
    for (const p of leftover(avail.players, picks.players) ?? []) out.players.add(Number(p));
    for (const c of leftover(avail.cards, picks.cards) ?? []) out.cards.add(c);
    for (const g of leftover(avail.gardenType, picks.gardenType) ?? []) {
      out.gardenTypes.add(g as PlantableGardenType);
    }
  }
  return out;
}

/**
 * Is this selection still something the acting player can actually do?
 *
 *  - a selected unit must still exist and still have a legal move or a legal
 *    plant on its space (the same "actionable" test the board click uses);
 *  - an in-progress card targeting must still be an offered play, and the
 *    picks made so far must still lead to at least one valid target payload.
 *
 * Everything else is dropped, so a stale or now-illegal selection can never
 * survive a state update.
 */
function selectionStillValid(state: GameState, legal: readonly Action[], sel: Sel): boolean {
  if (sel.kind === 'none') return true;

  if (sel.kind === 'unit') {
    const u = state.units[sel.unitId];
    if (!u) return false;
    return legal.some(
      (a) =>
        (a.type === 'move' && a.unitId === u.id) || (a.type === 'plant' && samePos(a.pos, u.pos)),
    );
  }

  const intent = targetIntent(sel);
  const stillOffered = legal.some(
    (a) => a.type === intent.type && a.player === sel.player && 'cardId' in a && a.cardId === sel.cardId,
  );
  if (!stillOffered) return false;
  return getTargetOptions(state, intent).some((c) => comboReachable(c, sel));
}

// ---------------------------------------------------------------------------
// GameScreen
// ---------------------------------------------------------------------------

export interface GameScreenProps {
  options: CreateGameOptions;
  seed: number;
  onPlayAgain: () => void;
  onQuit: () => void;
}

export function GameScreen({ options, seed, onPlayAgain, onQuit }: GameScreenProps) {
  const g = useGame(options, seed);
  const { state, dispatch, playerToAct, actorIsCpu, needsPass, playback } = g;
  const [sel, setSel] = useState<Sel>(NO_SEL);

  // Card plays are enumerated without targets here; the targeting flow gets
  // its options from getTargetOptions, so the expensive expansion is only paid
  // while a card is actually being aimed.
  const legal = useMemo(() => getLegalActionIntents(state), [state]);

  /**
   * Keep a selection across state updates when it is still valid, drop it when
   * it is not. Blanket-clearing on every state change used to interrupt
   * multi-step card targeting and tunnel chains whenever an unrelated update
   * landed (a CPU seat acting, a fight step, a toast-triggering re-render).
   */
  useEffect(() => {
    setSel((cur) => (selectionStillValid(state, legal, cur) ? cur : NO_SEL));
  }, [state, legal]);

  /** Reachable target payloads for the in-progress targeting, if any. */
  const targetCombos = useMemo(
    () => (sel.kind === 'target' ? getTargetOptions(state, targetIntent(sel)) : []),
    [state, sel],
  );
  const reachable = useMemo(
    () => (sel.kind === 'target' ? targetCombos.filter((c) => comboReachable(c, sel)) : []),
    [targetCombos, sel],
  );
  const candidates = useMemo(
    () => (sel.kind === 'target' ? candidatesFrom(reachable, sel) : null),
    [reachable, sel],
  );

  /** True when the on-screen human may interact with board/panels. */
  const interactive =
    state.status !== 'finished' && playerToAct !== null && !actorIsCpu && !needsPass && !playback;

  /** Whose hand is on screen: the revealed human seat. */
  const handSeat =
    g.revealedSeat !== null && state.players[g.revealedSeat]?.controller === 'human'
      ? g.revealedSeat
      : null;

  const handPlayable = useMemo(() => {
    const set = new Set<CardId>();
    if (handSeat === null || needsPass || playback) return set;
    for (const a of getLegalActionIntents(state, handSeat)) {
      if (a.type === 'playCard') set.add(a.cardId);
    }
    return set;
  }, [state, handSeat, needsPass, playback]);

  const decision = state.pendingDecision;

  // --- dispatch helpers ------------------------------------------------------

  function act(action: Action) {
    const ok = dispatch(action);
    // A targeting session ends the moment its card is dispatched (a second
    // copy of the same card in hand must not silently inherit the picks), and
    // a rejected action drops the selection outright. Otherwise the selection
    // is left to the validity check above — so a gnome you just moved stays
    // selected and can still plant on its new space.
    if (!ok || sel.kind === 'target') setSel(NO_SEL);
  }

  /** Begin playing a card: dispatch immediately if untargeted, else enter targeting. */
  function startCardPlay(cardId: CardId, respond: boolean, player: PlayerId) {
    const def = getCardDef(cardId);
    if (!def || !def.needsTargets || !def.targetSpec) {
      act(
        respond
          ? { type: 'respondPlayCard', player, cardId }
          : { type: 'playCard', player, cardId },
      );
      return;
    }
    // A card can pass the cheap playability check and still have no valid
    // target on this board (the check is deliberately coarser than `validate`).
    // Say so instead of opening a targeting mode with nothing to click.
    const intent: Action = respond
      ? { type: 'respondPlayCard', player, cardId }
      : { type: 'playCard', player, cardId };
    if (getTargetOptions(state, intent).length === 0) {
      g.pushToast(`${def.name}: no legal targets right now`);
      return;
    }
    setSel({
      kind: 'target',
      cardId,
      respond,
      player,
      spec: def.targetSpec,
      units: [],
      spaces: [],
      players: [],
      cards: [],
    });
  }

  /**
   * Attempt to play with the chosen targets. Pre-checks via the card's own
   * validate (engine-authored) so a bad pick can be retried; `fallback`
   * restores the previous picks on failure.
   */
  function attemptPlay(t: TargetSel, fallback: Sel | null) {
    const def = getCardDef(t.cardId);
    const targets = buildTargets(t);
    if (def?.validate) {
      const err = def.validate(state, t.player, targets);
      if (err) {
        g.pushToast(`${def.name}: ${err}`);
        if (fallback) setSel(fallback);
        return;
      }
    }
    act(
      t.respond
        ? { type: 'respondPlayCard', player: t.player, cardId: t.cardId, targets }
        : { type: 'playCard', player: t.player, cardId: t.cardId, targets },
    );
  }

  /** Add a pick; auto-plays when every slot in the spec is filled. */
  function addPick(next: TargetSel, prev: Sel) {
    if (targetingComplete(next)) attemptPlay(next, prev);
    else setSel(next);
  }

  // --- board click routing -----------------------------------------------------

  function onCellClick(pos: Pos) {
    if (!interactive || playerToAct === null) return;

    // 1) Card targeting mode: units first, then spaces. Only picks that keep a
    // valid payload reachable are accepted — the candidate sets come from the
    // engine's enumeration, so the UI never guesses at a card's rules.
    if (sel.kind === 'target' && candidates) {
      const t = sel;
      if (t.spec.units && t.units.length < t.spec.units.count) {
        const cand = unitsAt(state, pos).find((u) => candidates.units.has(u.id));
        if (cand) {
          addPick({ ...t, units: [...t.units, cand.id] }, t);
          return;
        }
      }
      if (t.spec.spaces && t.spaces.length < t.spec.spaces.count && candidates.spaces.has(posKey(pos))) {
        addPick({ ...t, spaces: [...t.spaces, pos] }, t);
      }
      return;
    }

    // 2) Board-picking decisions.
    if (decision) {
      if (decision.player !== playerToAct) return;
      if (decision.kind === 'slide' || decision.kind === 'tunnel') {
        if (decision.options.some((o) => samePos(o, pos))) {
          act({ type: decision.kind, player: decision.player, to: pos });
        }
        return;
      }
      if (decision.kind === 'snailMove') {
        if (decision.options.some((o) => samePos(o, pos))) {
          act({ type: 'snailMove', player: decision.player, to: pos });
        }
        return;
      }
      if (decision.kind === 'chooseHarvest') {
        const opt = decision.options.find((o) => samePos(o.pos, pos));
        if (opt) act({ type: 'chooseHarvest', player: decision.player, sourceKey: opt.key });
        return;
      }
      if (decision.kind === 'sacrificeGnome') {
        const unit = decision.options
          .map((id) => state.units[id])
          .find((u) => u && samePos(u.pos, pos));
        if (unit) act({ type: 'sacrificeGnome', player: decision.player, unitId: unit.id });
        return;
      }
      return; // other decisions don't use the board
    }

    // 3) Action Phase: move a selected unit.
    if (sel.kind === 'unit') {
      const mv = legal.find(
        (a) => a.type === 'move' && a.unitId === sel.unitId && samePos(a.to, pos),
      );
      if (mv) {
        act(mv);
        return;
      }
    }

    // 4) Select (or cycle through) own actionable units on the clicked space —
    // "actionable" means a legal move OR a legal plant at that space (a gnome
    // that already moved this turn can't move again, but can still plant).
    const actionable = unitsAt(state, pos).filter(
      (u) =>
        u.owner === playerToAct &&
        (legal.some((a) => a.type === 'move' && a.unitId === u.id) ||
          legal.some((a) => a.type === 'plant' && samePos(a.pos, pos))),
    );
    if (actionable.length > 0) {
      let next = actionable[0];
      if (sel.kind === 'unit') {
        const i = actionable.findIndex((u) => u.id === sel.unitId);
        if (i >= 0) next = actionable[(i + 1) % actionable.length];
      }
      setSel({ kind: 'unit', unitId: next.id });
      return;
    }
    setSel(NO_SEL);
  }

  // --- highlights ---------------------------------------------------------------

  const highlights = useMemo(() => {
    const map = new Map<string, HighlightKind>();
    if (!interactive) return map;

    if (sel.kind === 'target' && candidates) {
      const t = sel;
      // Only cells that keep a valid target payload reachable are offered.
      if (t.spec.units && t.units.length < t.spec.units.count) {
        for (const id of candidates.units) {
          const u = state.units[id];
          if (u) map.set(posKey(u.pos), 'target');
        }
      }
      if (t.spec.spaces && t.spaces.length < t.spec.spaces.count) {
        for (const k of candidates.spaces) map.set(k, 'target');
      }
      for (const q of t.spaces) map.set(posKey(q), 'picked');
      for (const uid of t.units) {
        const u = state.units[uid];
        if (u) map.set(posKey(u.pos), 'picked');
      }
      return map;
    }

    if (decision) {
      if (decision.kind === 'slide' || decision.kind === 'tunnel' || decision.kind === 'snailMove') {
        for (const o of decision.options) map.set(posKey(o), 'decision');
      } else if (decision.kind === 'chooseHarvest') {
        for (const o of decision.options) map.set(posKey(o.pos), 'decision');
      } else if (decision.kind === 'sacrificeGnome') {
        for (const id of decision.options) {
          const u = state.units[id];
          if (u) map.set(posKey(u.pos), 'decision');
        }
      }
      return map;
    }

    if (sel.kind === 'unit') {
      for (const a of legal) {
        if (a.type === 'move' && a.unitId === sel.unitId) map.set(posKey(a.to), 'move');
      }
    }
    return map;
  }, [state, sel, decision, legal, interactive, candidates]);

  const selectedKey =
    sel.kind === 'unit' && state.units[sel.unitId] ? posKey(state.units[sel.unitId].pos) : null;

  // --- action bar (active human, action phase) ------------------------------------

  const showActionBar =
    interactive && !decision && state.turn?.phase === 'action' && state.turn.activePlayer === playerToAct;
  const canDraw = legal.some((a) => a.type === 'drawCard');
  const plantActions =
    sel.kind === 'unit' && state.units[sel.unitId]
      ? legal.filter(
          (a): a is Extract<Action, { type: 'plant' }> =>
            a.type === 'plant' && samePos(a.pos, state.units[(sel as { unitId: UnitId }).unitId].pos),
        )
      : [];

  return (
    /* The data-* attributes mirror already-visible game state (status, phase,
       whose decision is open). They exist so browser tests can wait on a
       condition without scraping prose from the banner. */
    <div
      className="game-screen"
      data-testid="game-screen"
      data-status={state.status}
      data-phase={state.turn?.phase ?? ''}
      data-turn={state.turn?.number ?? ''}
      data-active-player={state.turn?.activePlayer ?? ''}
      data-player-to-act={playerToAct ?? ''}
      data-decision={decision?.kind ?? ''}
      data-interactive={interactive ? 'true' : 'false'}
    >
      <header className="topbar">
        <span className="brand">🧙 Whimsy Wars</span>
        <span className="banner" data-testid="banner">{bannerText(state, playerToAct)}</span>
        <label className="ff-toggle" title="Skip CPU pacing and fight animations">
          <input
            type="checkbox"
            checked={g.fastForward}
            onChange={(e) => g.setFastForward(e.target.checked)}
          />
          ⏩ fast CPU
        </label>
        <span className="seed-tag" title="Game seed">#{seed}</span>
        <button type="button" className="btn small" onClick={onQuit}>
          New game
        </button>
      </header>

      <div className="main">
        <aside className="left-col">
          <PlayerPanels state={state} />
          <SupplyPanel state={state} />
          {state.activeCurses.length > 0 && <CursePanel state={state} />}
        </aside>

        <section className="board-wrap">
          <Board
            state={state}
            highlights={highlights}
            selectedKey={selectedKey}
            onCellClick={onCellClick}
          />
          {/* Stable-height slot: the bar appearing/disappearing must not
              reflow the board. Targeting replaces the action bar. */}
          <div className="board-footer">
            {sel.kind === 'target' && candidates ? (
              <TargetingBanner
                state={state}
                t={sel}
                candidates={candidates}
                onCancel={() => setSel(NO_SEL)}
                onPick={addPick}
                onConfirm={() => attemptPlay(sel, sel)}
              />
            ) : showActionBar ? (
              <div className="action-bar" data-testid="action-bar">
                <button
                  type="button"
                  className="btn"
                  disabled={!canDraw}
                  data-testid="draw-card"
                  onClick={() => act({ type: 'drawCard', player: playerToAct! })}
                >
                  🃏 Draw card (1 ✨)
                </button>
                {plantActions.map((a) => (
                  <button key={a.gardenType} type="button" className="btn" data-testid={`plant-${a.gardenType}`} onClick={() => act(a)}>
                    {GARDEN_META[a.gardenType].emoji} Plant {GARDEN_META[a.gardenType].label}
                  </button>
                ))}
                {sel.kind === 'unit' && (
                  <button type="button" className="btn small" data-testid="deselect" onClick={() => setSel(NO_SEL)}>
                    Deselect
                  </button>
                )}
                <button
                  type="button"
                  className="btn warn"
                  data-testid="end-turn"
                  onClick={() => act({ type: 'endTurn', player: playerToAct! })}
                >
                  End turn ⏹
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <aside className="right-col">
          {decision && decision.kind !== 'fightRespond' && (
            <DecisionPanel
              state={state}
              decision={decision}
              legal={legal}
              interactive={interactive && decision.player === playerToAct}
              act={act}
              onRespondCard={(cardId, player) => startCardPlay(cardId, true, player)}
            />
          )}
          {state.fight && (
            <FightPanel
              state={state}
              interactive={interactive && decision?.kind === 'fightRespond'}
              onPass={() =>
                decision?.kind === 'fightRespond' && act({ type: 'respondPass', player: decision.player })
              }
              onPlayCard={(cardId) =>
                decision?.kind === 'fightRespond' && startCardPlay(cardId, true, decision.player)
              }
            />
          )}
          <HandPanel
            state={state}
            seat={handSeat}
            playable={handPlayable}
            onPlay={(cardId) => handSeat !== null && startCardPlay(cardId, false, handSeat)}
            disabled={needsPass || !!playback || state.status === 'finished'}
          />
          <GameLog state={state} />
        </aside>
      </div>

      {/* Overlays (priority: end > fight playback > pass interstitial) */}
      {state.status === 'finished' ? (
        <EndOverlay state={state} onPlayAgain={onPlayAgain} onQuit={onQuit} />
      ) : playback ? (
        <FightPlaybackOverlay state={state} playback={playback} onSkip={g.skipPlayback} />
      ) : needsPass && playerToAct !== null ? (
        <PassOverlay state={state} seat={playerToAct} onConfirm={g.confirmPass} />
      ) : null}

      <div className="toasts">
        {g.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function bannerText(state: GameState, playerToAct: PlayerId | null): string {
  if (state.status === 'finished') {
    return state.winner !== null ? `🏆 ${pname(state, state.winner)} wins!` : 'Game over — no winner.';
  }
  if (state.status === 'rolloff') {
    return `🎲 Rolling for turn order — ${playerToAct !== null ? pname(state, playerToAct) : '…'} to roll`;
  }
  const t = state.turn;
  if (!t) return '…';
  let s = `Turn ${t.number} · ${pname(state, t.activePlayer)} · ${t.phase === 'harvest' ? '🌾 Harvest' : '⚡ Action'} Phase`;
  const d = state.pendingDecision;
  if (playerToAct !== null && (playerToAct !== t.activePlayer || d)) {
    s += ` — ${pname(state, playerToAct)} must act${d ? ` (${decisionLabel(d.kind)})` : ''}`;
  }
  return s;
}

function SupplyPanel({ state }: { state: GameState }) {
  return (
    <div className="supply-panel">
      <div className="panel-title">Garden supply</div>
      <div className="supply-grid">
        {Object.entries(state.supply).map(([type, count]) => (
          <span key={type} title={GARDEN_META[type as keyof typeof GARDEN_META].label}>
            {GARDEN_META[type as keyof typeof GARDEN_META].emoji} {count}
          </span>
        ))}
      </div>
    </div>
  );
}

function CursePanel({ state }: { state: GameState }) {
  return (
    <div className="curse-panel">
      <div className="panel-title">☠️ Active Curses</div>
      {state.activeCurses.map((id) => (
        <div key={id} className="small" title={cardName(id)}>
          <b>{cardName(id)}</b>
        </div>
      ))}
    </div>
  );
}

function TargetingBanner({
  state,
  t,
  candidates,
  onCancel,
  onPick,
  onConfirm,
}: {
  state: GameState;
  t: TargetSel;
  candidates: TargetCandidates;
  onCancel: () => void;
  onPick: (next: TargetSel, prev: Sel) => void;
  onConfirm: () => void;
}) {
  const wants: string[] = [];
  if (t.spec.units && t.units.length < t.spec.units.count) {
    wants.push(`${t.spec.units.description} (${t.units.length}/${t.spec.units.count})`);
  }
  if (t.spec.spaces && t.spaces.length < t.spec.spaces.count) {
    wants.push(`${t.spec.spaces.description} (${t.spaces.length}/${t.spec.spaces.count})`);
  }

  const needPlayers = t.spec.players ? t.spec.players.count - t.players.length : 0;
  const needCards = t.spec.cards ? t.spec.cards.count - t.cards.length : 0;
  const needGardenType = !!t.spec.gardenType && t.gardenType === undefined;

  // Choices come from the engine's enumeration (already narrowed by the picks
  // so far), so every button shown leads to a legal play.
  const eligiblePlayers = needPlayers > 0 ? state.players.filter((p) => candidates.players.has(p.id)) : [];
  const discardChoices = needCards > 0 ? [...new Set(state.discard)].filter((c) => candidates.cards.has(c)) : [];
  const gardenTypes = needGardenType
    ? (Object.keys(state.supply) as PlantableGardenType[]).filter((gt) => candidates.gardenTypes.has(gt))
    : [];

  return (
    <div className="targeting-banner" data-testid="targeting-banner">
      <span>
        🎯 <b>{cardName(t.cardId)}</b>
        {wants.length > 0 && <>: click {wants.join(', then ')}</>}
        {t.spec.players && needPlayers > 0 && <> · choose {t.spec.players.description}</>}
        {t.spec.cards && needCards > 0 && <> · choose {t.spec.cards.description}</>}
        {needGardenType && <> · choose {t.spec.gardenType!.description}</>}
      </span>
      {eligiblePlayers.map((p) => (
        <button
          key={p.id}
          type="button"
          className="btn small"
          style={{ borderColor: playerColor(p.id) }}
          onClick={() => onPick({ ...t, players: [...t.players, p.id] }, t)}
        >
          {p.name}
        </button>
      ))}
      {discardChoices.map((c) => (
        <button
          key={c}
          type="button"
          className="btn small"
          onClick={() => onPick({ ...t, cards: [...t.cards, c] }, t)}
        >
          {cardName(c)}
        </button>
      ))}
      {gardenTypes.map((gt) => (
        <button
          key={gt}
          type="button"
          className="btn small"
          onClick={() => onPick({ ...t, gardenType: gt }, t)}
        >
          {GARDEN_META[gt].emoji} {GARDEN_META[gt].label}
        </button>
      ))}
      {anyTargetPicked(t) && !targetingComplete(t) && (
        <button type="button" className="btn small accent" data-testid="targeting-confirm" onClick={onConfirm}>
          Play with current targets
        </button>
      )}
      <button type="button" className="btn small warn" data-testid="targeting-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function PassOverlay({
  state,
  seat,
  onConfirm,
}: {
  state: GameState;
  seat: PlayerId;
  onConfirm: () => void;
}) {
  return (
    <div className="overlay opaque" role="dialog" aria-label="Pass the device" data-testid="pass-overlay">
      <div className="overlay-card pass-card">
        <div className="pass-emoji">🤝</div>
        <h2>
          Pass the device to <span style={{ color: playerColor(seat) }}>{pname(state, seat)}</span>
        </h2>
        <p className="muted">Hands stay hidden until they take over.</p>
        <button type="button" className="btn accent big" data-testid="pass-confirm" onClick={onConfirm}>
          I'm {pname(state, seat)} — continue
        </button>
      </div>
    </div>
  );
}

function EndOverlay({
  state,
  onPlayAgain,
  onQuit,
}: {
  state: GameState;
  onPlayAgain: () => void;
  onQuit: () => void;
}) {
  const w = state.winner;
  return (
    <div className="overlay" role="dialog" aria-label="Game over" data-testid="end-overlay">
      <div className="overlay-card end-card">
        <div className="pass-emoji">{w !== null ? '🏆' : '🍂'}</div>
        <h2>
          {w !== null ? (
            <>
              <span style={{ color: playerColor(w) }}>{pname(state, w)}</span> wins Whimsy Wars!
            </>
          ) : (
            'Nobody wins — the garden falls silent.'
          )}
        </h2>
        <div className="btn-row center">
          <button type="button" className="btn accent big" onClick={onPlayAgain}>
            🔁 Play again (new seed)
          </button>
          <button type="button" className="btn big" onClick={onQuit}>
            Change setup
          </button>
        </div>
      </div>
    </div>
  );
}
