/**
 * Side panels: player status cards, game log, hand, and the fight views
 * (live respond panel + finished-fight step-through overlay).
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CardId, GameEvent, GameState, PlayerId } from '../engine';
import {
  getCardDef,
  getPlayerToAct,
  gnomesOnBoard,
  reserveGnomes,
  wishCap,
} from '../engine';
import type { FightPlayback } from './useGame';
import {
  cardName,
  describeEvent,
  dieFace,
  playerColor,
  pname,
  posStr,
  sideName,
} from './meta';

// ---------------------------------------------------------------------------
// Player panels
// ---------------------------------------------------------------------------

export function PlayerPanels({ state }: { state: GameState }) {
  const actor = state.status === 'finished' ? null : getPlayerToAct(state);
  const active = state.turn?.activePlayer ?? null;
  return (
    <div className="player-panels">
      {state.players.map((p) => {
        const cap = wishCap(state, p.id);
        const classes = ['player-panel', `status-${p.status}`];
        if (p.id === active) classes.push('active-turn');
        if (p.id === actor) classes.push('to-act');
        return (
          <div
            key={p.id}
            className={classes.join(' ')}
            style={{ '--pc': playerColor(p.id) } as CSSProperties}
          >
            <div className="pp-head">
              <span className="pp-dot" />
              <span className="pp-name">{p.name}</span>
              <span className="pp-ctl">{p.controller === 'cpu' ? '🤖' : '🧑'}</span>
              {p.id === actor && <span className="pp-act">acting</span>}
            </div>
            {p.status === 'playing' ? (
              <div className="pp-stats">
                <span title={`Wishes (cap ${cap})`}>✨ {p.wishes}/{cap}</span>
                <span title="Gnomes on board / limit">🧙 {gnomesOnBoard(state, p.id)}/{state.config.gnomeBoardLimit}</span>
                <span title="Reserve gnomes remaining">📦 {reserveGnomes(state, p.id)}</span>
                <span title="Cards in hand">🃏 {p.hand.length}</span>
              </div>
            ) : (
              <div className="pp-stats">
                <span>{p.status === 'snail' ? '🐌 Immortal Snail' : '💀 Out of the game'}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game log
// ---------------------------------------------------------------------------

export function GameLog({ state }: { state: GameState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const count = state.events.length;
  useEffect(() => {
    if (collapsed) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, collapsed]);

  const start = Math.max(0, count - 250);
  return (
    <div className={`game-log-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="panel-title log-title">
        <span>📜 Game log</span>
        <button
          type="button"
          className="btn small"
          aria-expanded={!collapsed}
          data-testid="log-collapse"
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? 'Show ▸' : 'Hide ▾'}
        </button>
      </div>
      {!collapsed && (
        <div className="game-log" ref={ref} aria-label="Game log">
          {state.events.slice(start).map((ev, i) => (
            <div key={start + i} className={`log-line log-${ev.type}`}>
              {describeEvent(state, ev)}
            </div>
          ))}
          {count === 0 && <div className="log-line muted">The garden awaits…</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hand
// ---------------------------------------------------------------------------

export interface HandPanelProps {
  state: GameState;
  /** Whose hand is shown (a human seat), or null to hide all hands. */
  seat: PlayerId | null;
  /** Card ids playable right now via a normal playCard action. */
  playable: ReadonlySet<CardId>;
  onPlay: (cardId: CardId) => void;
  disabled: boolean;
}

export function HandPanel({ state, seat, playable, onPlay, disabled }: HandPanelProps) {
  if (seat === null) {
    return (
      <div className="hand-panel">
        <div className="panel-title">Hand</div>
        <div className="muted small">Hands are hidden (CPU seats).</div>
      </div>
    );
  }
  const p = state.players[seat];
  return (
    <div className="hand-panel">
      <div className="panel-title">
        {p.name}'s hand ({p.hand.length}/{state.config.handLimit})
        <span className="deck-info">
          deck {state.deck.length} · discard {state.discard.length}
        </span>
      </div>
      {p.hand.length === 0 ? (
        <div className="muted small">No cards. Draw one for 1 ✨ during your Action Phase.</div>
      ) : (
        <div className="hand-cards" data-testid="hand-cards">
          {p.hand.map((cardId, i) => {
            const def = getCardDef(cardId);
            return (
              <div key={`${cardId}-${i}`} className={`card ${def?.timing ?? 'unknown'}`}>
                <div className="card-head">
                  <span className="card-name">{cardName(cardId)}</span>
                  <span className="card-timing">{def ? (def.timing === 'sudden' ? '⚡ Sudden' : '🕯️ Ritual') : '?'}</span>
                </div>
                <div className="card-text">{def?.text ?? 'Unknown card (engine card list in progress).'}</div>
                <button
                  type="button"
                  className="btn small"
                  disabled={disabled || !playable.has(cardId)}
                  data-testid={`play-card-${cardId}`}
                  onClick={() => onPlay(cardId)}
                >
                  Play
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fight: live respond panel
// ---------------------------------------------------------------------------

export interface FightPanelProps {
  state: GameState;
  /** True when the respond controls should be shown (human actor, revealed). */
  interactive: boolean;
  onPass: () => void;
  onPlayCard: (cardId: CardId) => void;
}

export function FightPanel({ state, interactive, onPass, onPlayCard }: FightPanelProps) {
  const f = state.fight;
  if (!f) return null;
  const rolls = state.events.filter(
    (e): e is Extract<GameEvent, { type: 'fightRolled' }> =>
      e.type === 'fightRolled' && e.fightId === f.id,
  );
  const d = state.pendingDecision;
  const respond = d?.kind === 'fightRespond' ? d : null;
  return (
    <div className="fight-panel" data-testid="fight-panel">
      <div className="panel-title">⚔️ Fight at {posStr(f.pos)} — round {f.round}</div>
      <div className="fight-sides">
        <FightSideBadge state={state} idx={0} f={f} />
        <span className="vs">vs</span>
        <FightSideBadge state={state} idx={1} f={f} />
      </div>
      {rolls.length > 0 && (
        <div className="fight-rolls">
          {rolls.slice(-4).map((r, i) => (
            <span key={i} className="roll-pair">
              {dieFace(r.rolls[0])} {r.rolls[0]} : {dieFace(r.rolls[1])} {r.rolls[1]}
              {r.tie ? ' (tie)' : ''}
            </span>
          ))}
        </div>
      )}
      {respond && (
        <div className="fight-respond">
          <div className="small">
            <b>{pname(state, respond.player)}</b> may respond with Sudden Magic.
          </div>
          {interactive ? (
            <div className="btn-row">
              <button type="button" className="btn" data-testid="fight-respond-pass" onClick={onPass}>
                Pass
              </button>
              {respond.playableCards.map((cardId) => (
                <button
                  key={cardId}
                  type="button"
                  className="btn accent"
                  data-testid={`fight-respond-card-${cardId}`}
                  onClick={() => onPlayCard(cardId)}
                >
                  Play {cardName(cardId)}
                </button>
              ))}
            </div>
          ) : (
            <div className="muted small">Waiting…</div>
          )}
        </div>
      )}
    </div>
  );
}

function FightSideBadge({
  state,
  f,
  idx,
}: {
  state: GameState;
  f: NonNullable<GameState['fight']>;
  idx: 0 | 1;
}) {
  const side = f.sides[idx];
  const color = side.kind === 'player' ? playerColor(side.player) : '#3c7a3c';
  return (
    <span className="fight-side" style={{ '--pc': color } as CSSProperties}>
      {side.kind === 'flytrap' ? '🪤' : '🧙'} {sideName(state, side)}
      <span className="side-role">{idx === 0 ? 'defender' : 'attacker'}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Fight: finished-fight step-through overlay
// ---------------------------------------------------------------------------

export interface FightPlaybackProps {
  state: GameState;
  playback: FightPlayback;
  onSkip: () => void;
}

export function FightPlaybackOverlay({ state, playback, onSkip }: FightPlaybackProps) {
  const shownEvents = playback.events.slice(0, playback.shown);
  // Header describes the most recent fight in the shown window.
  let header = '⚔️ Fight!';
  let lastRoll: Extract<GameEvent, { type: 'fightRolled' }> | null = null;
  for (const ev of shownEvents) {
    if (ev.type === 'fightStarted') {
      header = `⚔️ ${sideName(state, ev.sides[1])} attacks ${sideName(state, ev.sides[0])} at ${posStr(ev.pos)}`;
      lastRoll = null;
    }
    if (ev.type === 'fightRolled') lastRoll = ev;
  }
  return (
    <div className="overlay" role="dialog" aria-label="Fight">
      <div className="overlay-card fight-overlay">
        <div className="fight-header">{header}</div>
        {lastRoll && (
          <div className="big-dice" key={shownEvents.length}>
            <span className="die">{dieFace(lastRoll.rolls[0])}</span>
            <span className="vs">vs</span>
            <span className="die">{dieFace(lastRoll.rolls[1])}</span>
          </div>
        )}
        <div className="fight-steps">
          {shownEvents.map((ev, i) => (
            <div key={i} className={`log-line${i === shownEvents.length - 1 ? ' latest' : ''}`}>
              {describeEvent(state, ev)}
            </div>
          ))}
        </div>
        <button type="button" className="btn" data-testid="skip-playback" onClick={onSkip}>
          Skip ⏭
        </button>
      </div>
    </div>
  );
}
