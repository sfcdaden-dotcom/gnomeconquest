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
import { getCardDef, getLegalActions, posKey, samePos, unitsAt } from '../engine';
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

  // Any state change invalidates the current selection/targeting.
  useEffect(() => setSel(NO_SEL), [state]);

  const legal = useMemo(() => getLegalActions(state), [state]);

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
    for (const a of getLegalActions(state, handSeat)) {
      if (a.type === 'playCard') set.add(a.cardId);
    }
    return set;
  }, [state, handSeat, needsPass, playback]);

  const decision = state.pendingDecision;

  // --- dispatch helpers ------------------------------------------------------

  function act(action: Action) {
    dispatch(action);
    setSel(NO_SEL);
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

    // 1) Card targeting mode: fill unit slots first, then space slots.
    if (sel.kind === 'target') {
      const t = sel;
      if (t.spec.units && t.units.length < t.spec.units.count) {
        const cand = unitsAt(state, pos).find((u) => !t.units.includes(u.id));
        if (cand) {
          addPick({ ...t, units: [...t.units, cand.id] }, t);
          return;
        }
      }
      if (
        t.spec.spaces &&
        t.spaces.length < t.spec.spaces.count &&
        !t.spaces.some((q) => samePos(q, pos))
      ) {
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

    if (sel.kind === 'target') {
      const t = sel;
      // Unit slots: candidate cells (any unit; the card's validate is the judge).
      if (t.spec.units && t.units.length < t.spec.units.count) {
        for (const u of Object.values(state.units)) {
          if (!t.units.includes(u.id)) map.set(posKey(u.pos), 'target');
        }
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
  }, [state, sel, decision, legal, interactive]);

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
    <div className="game-screen">
      <header className="topbar">
        <span className="brand">🧙 Whimsy Wars</span>
        <span className="banner">{bannerText(state, playerToAct)}</span>
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
            {sel.kind === 'target' ? (
              <TargetingBanner
                state={state}
                t={sel}
                onCancel={() => setSel(NO_SEL)}
                onPick={addPick}
                onConfirm={() => attemptPlay(sel, sel)}
              />
            ) : showActionBar ? (
              <div className="action-bar">
                <button
                  type="button"
                  className="btn"
                  disabled={!canDraw}
                  onClick={() => act({ type: 'drawCard', player: playerToAct! })}
                >
                  🃏 Draw card (1 ✨)
                </button>
                {plantActions.map((a) => (
                  <button key={a.gardenType} type="button" className="btn" onClick={() => act(a)}>
                    {GARDEN_META[a.gardenType].emoji} Plant {GARDEN_META[a.gardenType].label}
                  </button>
                ))}
                {sel.kind === 'unit' && (
                  <button type="button" className="btn small" onClick={() => setSel(NO_SEL)}>
                    Deselect
                  </button>
                )}
                <button
                  type="button"
                  className="btn warn"
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
  onCancel,
  onPick,
  onConfirm,
}: {
  state: GameState;
  t: TargetSel;
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

  const eligiblePlayers = needPlayers > 0 ? state.players.filter((p) => !t.players.includes(p.id)) : [];
  const discardChoices = needCards > 0 ? [...new Set(state.discard)].filter((c) => !t.cards.includes(c)) : [];
  const gardenTypes = needGardenType
    ? (Object.keys(state.supply) as PlantableGardenType[]).filter((gt) => state.supply[gt] > 0)
    : [];

  return (
    <div className="targeting-banner">
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
        <button type="button" className="btn small accent" onClick={onConfirm}>
          Play with current targets
        </button>
      )}
      <button type="button" className="btn small warn" onClick={onCancel}>
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
    <div className="overlay opaque" role="dialog" aria-label="Pass the device">
      <div className="overlay-card pass-card">
        <div className="pass-emoji">🤝</div>
        <h2>
          Pass the device to <span style={{ color: playerColor(seat) }}>{pname(state, seat)}</span>
        </h2>
        <p className="muted">Hands stay hidden until they take over.</p>
        <button type="button" className="btn accent big" onClick={onConfirm}>
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
    <div className="overlay" role="dialog" aria-label="Game over">
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
