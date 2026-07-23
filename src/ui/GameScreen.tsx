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
  CardTarget,
  CreateGameOptions,
  GameState,
  PendingDecision,
  PlayerId,
  Pos,
  UnitId,
} from '../engine';
import { getLegalActionIntents, getPendingDecisionOptions, posKey, samePos, unitsAt } from '../engine';
import { Board } from './Board';
import type { HighlightKind } from './Board';
import { DecisionPanel } from './DecisionPanel';
import { FightPanel, FightPlaybackOverlay, GameLog, HandPanel, PlayerPanels } from './panels';
import { GARDEN_META, cardName, decisionLabel, playerColor, pname } from './meta';
import { useGame } from './useGame';

// ---------------------------------------------------------------------------
// Unit selection state
//
// Card targeting is NOT tracked here: it lives entirely in the engine as a
// `cardTargeting` pending decision, and the UI renders the current step's
// options from `getPendingDecisionOptions`. The only local selection is which
// of the acting player's own units is highlighted for moving / planting.
// ---------------------------------------------------------------------------

type Sel = { kind: 'none' } | { kind: 'unit'; unitId: UnitId };

const NO_SEL: Sel = { kind: 'none' };

/**
 * Is the selected unit still actionable? It must still exist and still have a
 * legal move or a legal plant on its space (the same test the board click
 * uses), so a stale selection can never survive a state update.
 */
function selectionStillValid(state: GameState, legal: readonly Action[], sel: Sel): boolean {
  if (sel.kind === 'none') return true;
  const u = state.units[sel.unitId];
  if (!u) return false;
  return legal.some(
    (a) => (a.type === 'move' && a.unitId === u.id) || (a.type === 'plant' && samePos(a.pos, u.pos)),
  );
}

/**
 * The card-agnostic board option at `pos`, if any: a space option matching the
 * cell, or a unit option whose unit stands on it. The engine's options carry
 * the card's rules; the UI just matches by kind, never by card id.
 */
function boardOptionAt(options: readonly CardTarget[], state: GameState, pos: Pos): CardTarget | null {
  for (const o of options) {
    if (o.kind === 'space' && samePos(o.pos, pos)) return o;
    if (o.kind === 'unit') {
      const u = state.units[o.unitId];
      if (u && samePos(u.pos, pos)) return o;
    }
  }
  return null;
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

  // Card plays are enumerated WITHOUT targets — dispatching a targeted play
  // opens a `cardTargeting` decision, and the engine then hands back one step's
  // options at a time, so no combinatorial expansion is ever paid in the UI.
  const legal = useMemo(() => getLegalActionIntents(state), [state]);

  /**
   * Keep a unit selection across state updates when it is still valid, drop it
   * when it is not. Blanket-clearing on every state change used to interrupt
   * tunnel chains whenever an unrelated update landed (a CPU seat acting, a
   * fight step, a toast-triggering re-render).
   */
  useEffect(() => {
    setSel((cur) => (selectionStillValid(state, legal, cur) ? cur : NO_SEL));
  }, [state, legal]);

  /**
   * Options for the current step of an in-progress card targeting (empty
   * otherwise). Recomputed from live state by the engine — the UI holds no
   * targeting state of its own.
   */
  const targetingOptions = useMemo(
    () => (state.pendingDecision?.kind === 'cardTargeting' ? getPendingDecisionOptions(state) : []),
    [state],
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
    // A rejected action drops the unit selection outright. Otherwise it is left
    // to the validity check above — so a gnome you just moved stays selected
    // and can still plant on its new space.
    if (!ok) setSel(NO_SEL);
  }

  /**
   * Begin playing a card. Dispatching WITHOUT targets lets the engine decide:
   * an untargeted card resolves at once; a targeted one opens a `cardTargeting`
   * decision (or reports "no legal targets" via a toast). The UI never builds
   * target payloads itself — it answers the engine's steps one at a time.
   */
  function startCardPlay(cardId: CardId, respond: boolean, player: PlayerId) {
    // Clear any unit selection so a card play does not visually collide with it.
    setSel(NO_SEL);
    act(
      respond
        ? { type: 'respondPlayCard', player, cardId }
        : { type: 'playCard', player, cardId },
    );
  }

  // --- board click routing -----------------------------------------------------

  function onCellClick(pos: Pos) {
    if (!interactive || playerToAct === null) return;

    // 1) Card targeting: the engine offers this step's options; the UI matches
    // the clicked cell against them by kind (unit on the cell, or the space
    // itself). It never inspects the card's rules.
    if (decision?.kind === 'cardTargeting') {
      if (decision.player !== playerToAct) return;
      const opt = boardOptionAt(targetingOptions, state, pos);
      if (opt) act({ type: 'selectTarget', player: decision.player, target: opt });
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

    if (decision?.kind === 'cardTargeting') {
      // Highlight this step's legal options (from the engine) and the picks
      // already made in earlier steps.
      for (const o of targetingOptions) {
        if (o.kind === 'space') map.set(posKey(o.pos), 'target');
        else if (o.kind === 'unit') {
          const u = state.units[o.unitId];
          if (u) map.set(posKey(u.pos), 'target');
        }
      }
      for (const q of decision.selected.spaces ?? []) map.set(posKey(q), 'picked');
      for (const uid of decision.selected.units ?? []) {
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
  }, [state, sel, decision, legal, interactive, targetingOptions]);

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
            {interactive && decision?.kind === 'cardTargeting' && decision.player === playerToAct ? (
              <TargetingBanner
                state={state}
                decision={decision}
                options={targetingOptions}
                onSelect={(target) => act({ type: 'selectTarget', player: decision.player, target })}
                onCancel={() => act({ type: 'cancelTargeting', player: decision.player })}
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
          {/* fightRespond → FightPanel; cardTargeting → the board-footer
              TargetingBanner. Everything else gets the DecisionPanel. */}
          {decision && decision.kind !== 'fightRespond' && decision.kind !== 'cardTargeting' && (
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

/**
 * Card-agnostic targeting banner. It renders whatever the engine's current
 * `cardTargeting` step asks for: unit / space steps are clicked on the board
 * (options are highlighted there), while player / card / gardenType steps show
 * chips. The prompt and the options both come from the engine — this component
 * has no per-card knowledge.
 */
function TargetingBanner({
  state,
  decision,
  options,
  onSelect,
  onCancel,
}: {
  state: GameState;
  decision: Extract<PendingDecision, { kind: 'cardTargeting' }>;
  options: readonly CardTarget[];
  onSelect: (target: CardTarget) => void;
  onCancel: () => void;
}) {
  const boardStep = decision.targetKind === 'unit' || decision.targetKind === 'space';
  return (
    <div className="targeting-banner" data-testid="targeting-banner">
      <span>
        🎯 <b>{cardName(decision.cardId)}</b>
        {decision.stepCount > 1 && <> ({decision.stepIndex + 1}/{decision.stepCount})</>}: {decision.prompt}
        {boardStep && <> — click a highlighted space</>}
      </span>
      {options.map((o) => (
        <TargetChip key={targetChipKey(o)} state={state} target={o} onSelect={onSelect} />
      ))}
      <button type="button" className="btn small warn" data-testid="targeting-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** A clickable chip for a non-board target (player / discard card / garden type). */
function TargetChip({
  state,
  target,
  onSelect,
}: {
  state: GameState;
  target: CardTarget;
  onSelect: (target: CardTarget) => void;
}) {
  // Unit / space options are picked on the board, not as chips.
  if (target.kind === 'unit' || target.kind === 'space') return null;
  if (target.kind === 'player') {
    return (
      <button
        type="button"
        className="btn small"
        style={{ borderColor: playerColor(target.playerId) }}
        onClick={() => onSelect(target)}
      >
        {pname(state, target.playerId)}
      </button>
    );
  }
  if (target.kind === 'card') {
    return (
      <button type="button" className="btn small" onClick={() => onSelect(target)}>
        {cardName(target.cardId)}
      </button>
    );
  }
  return (
    <button type="button" className="btn small" onClick={() => onSelect(target)}>
      {GARDEN_META[target.gardenType].emoji} {GARDEN_META[target.gardenType].label}
    </button>
  );
}

function targetChipKey(t: CardTarget): string {
  switch (t.kind) {
    case 'unit':
      return `u:${t.unitId}`;
    case 'space':
      return `s:${t.pos.x},${t.pos.y}`;
    case 'player':
      return `p:${t.playerId}`;
    case 'card':
      return `c:${t.cardId}`;
    case 'gardenType':
      return `g:${t.gardenType}`;
  }
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
