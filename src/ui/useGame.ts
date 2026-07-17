/**
 * Game session hook: holds the single GameState, dispatches actions through
 * the engine (EngineError → toast, never a crash), drives CPU seats on a
 * timer, replays fight events as a step-through, and gates pass-and-play
 * privacy between human seats.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, CreateGameOptions, GameEvent, GameState, PlayerId } from '../engine';
import { applyAction, chooseAiAction, createGame, getPlayerToAct } from '../engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

export interface FightPlayback {
  /** Fight-related events appended by the last action, replayed stepwise. */
  events: GameEvent[];
  /** Number of events currently revealed (0..events.length). */
  shown: number;
}

const FIGHT_EVENT_TYPES = new Set<GameEvent['type']>([
  'fightStarted',
  'fightRoundStarted',
  'fightRolled',
  'rollModified',
  'destructionPrevented',
  'unitDestroyed',
  'flytrapStunned',
  'snailSurvivedLoss',
  'fightEnded',
  'playerEliminated',
]);

const CPU_DELAY_MS = 400;
const CPU_FAST_MS = 25;

let toastSeq = 1;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGame(options: CreateGameOptions, seed: number) {
  const [state, setState] = useState<GameState>(() => createGame(options, seed));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fastForward, setFastForward] = useState(false);
  const [playback, setPlayback] = useState<FightPlayback | null>(null);
  /** Which human seat's private info (hand) is currently on screen. */
  const [revealedSeat, setRevealedSeat] = useState<PlayerId | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const fastRef = useRef(fastForward);
  fastRef.current = fastForward;

  const pushToast = useCallback((text: string, kind: Toast['kind'] = 'error') => {
    const id = toastSeq++;
    setToasts((ts) => [...ts.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4500);
  }, []);

  /** Apply one action; illegal actions surface as toasts and change nothing. */
  const dispatch = useCallback(
    (action: Action): boolean => {
      const prev = stateRef.current;
      let next: GameState;
      try {
        next = applyAction(prev, action);
      } catch (err) {
        pushToast(err instanceof Error ? err.message : String(err), 'error');
        return false;
      }
      // Fight step-through: replay the fight events this action produced,
      // unless fast-forwarding or the engine stopped inside the fight anyway
      // (a live Respond window shows its own panel). `events` is a trimmed
      // window, so diff via the monotonic eventCount, not array lengths.
      if (!fastRef.current && next.pendingDecision?.kind !== 'fightRespond') {
        const addedCount = Math.min(next.eventCount - prev.eventCount, next.events.length);
        const added = addedCount > 0 ? next.events.slice(next.events.length - addedCount) : [];
        const fightEvents = added.filter((e) => FIGHT_EVENT_TYPES.has(e.type));
        if (fightEvents.some((e) => e.type === 'fightRolled')) {
          setPlayback({ events: fightEvents, shown: 1 });
        }
      }
      stateRef.current = next;
      setState(next);
      return true;
    },
    [pushToast],
  );

  // --- fight playback auto-advance ----------------------------------------
  useEffect(() => {
    if (!playback) return;
    if (fastForward || playback.shown >= playback.events.length) {
      // Linger briefly on the final step, then dismiss.
      const t = window.setTimeout(() => setPlayback(null), fastForward ? 0 : 900);
      return () => window.clearTimeout(t);
    }
    const current = playback.events[playback.shown - 1];
    const delay = current?.type === 'fightRolled' ? 850 : 450;
    const t = window.setTimeout(
      () => setPlayback((p) => (p ? { ...p, shown: p.shown + 1 } : p)),
      delay,
    );
    return () => window.clearTimeout(t);
  }, [playback, fastForward]);

  const skipPlayback = useCallback(() => setPlayback(null), []);

  // --- seat bookkeeping -----------------------------------------------------
  const humanSeats = useMemo(
    () => state.players.filter((p) => p.controller === 'human').map((p) => p.id),
    [state.players],
  );

  const playerToAct = state.status === 'finished' ? null : getPlayerToAct(state);
  const actorIsCpu =
    playerToAct !== null && state.players[playerToAct].controller === 'cpu';

  // With exactly one human, that seat is always "revealed" (no privacy issue).
  useEffect(() => {
    if (humanSeats.length === 1 && revealedSeat !== humanSeats[0]) {
      setRevealedSeat(humanSeats[0]);
    }
  }, [humanSeats, revealedSeat]);

  /**
   * Pass-the-device interstitial: required when a human must act, there are
   * 2+ human seats, and the device was last "revealed" to a different seat.
   * The opening roll-off is exempt (hands are empty; nothing to hide).
   */
  const needsPass =
    playerToAct !== null &&
    !actorIsCpu &&
    humanSeats.length >= 2 &&
    state.status !== 'rolloff' &&
    revealedSeat !== playerToAct;

  const confirmPass = useCallback(() => {
    const actor = getPlayerToAct(stateRef.current);
    if (actor !== null) setRevealedSeat(actor);
  }, []);

  // --- CPU driver -----------------------------------------------------------
  useEffect(() => {
    if (state.status === 'finished') return;
    if (playback) return; // let humans watch the fight
    if (!actorIsCpu) return;
    const t = window.setTimeout(() => {
      const s = stateRef.current;
      const actor = getPlayerToAct(s);
      if (actor === null || s.players[actor].controller !== 'cpu') return;
      try {
        dispatch(chooseAiAction(s));
      } catch (err) {
        pushToast(
          `CPU error: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    }, fastForward ? CPU_FAST_MS : CPU_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [state, playback, actorIsCpu, fastForward, dispatch, pushToast]);

  return {
    state,
    dispatch,
    toasts,
    pushToast,
    fastForward,
    setFastForward,
    playback,
    skipPlayback,
    playerToAct,
    actorIsCpu,
    humanSeats,
    revealedSeat,
    needsPass,
    confirmPass,
  };
}

export type GameSession = ReturnType<typeof useGame>;
