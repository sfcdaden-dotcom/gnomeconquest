/**
 * Focused UI for the engine's pendingDecision. Known kinds get first-class
 * controls; anything unknown (new card decisions landing in the engine) falls
 * back to generic buttons enumerated from getLegalActions — the UI never
 * dead-ends.
 */

import type { ReactNode } from 'react';
import type { Action, CardId, GameState, PendingDecision, PlayerId } from '../engine';
import { GARDEN_META, cardName, describeAction, pname, posStr } from './meta';

export interface DecisionPanelProps {
  state: GameState;
  decision: PendingDecision;
  legal: readonly Action[];
  /** True when the deciding player is a revealed human (controls enabled). */
  interactive: boolean;
  act: (action: Action) => void;
  /** Begin a respondPlayCard play (enters targeting when the card needs it). */
  onRespondCard: (cardId: CardId, player: PlayerId) => void;
}

export function DecisionPanel({ state, decision, legal, interactive, act, onRespondCard }: DecisionPanelProps) {
  const who = pname(state, decision.player);

  if (!interactive) {
    return (
      <div className="decision-panel waiting">
        <div className="panel-title">⏳ {who} is deciding…</div>
      </div>
    );
  }

  switch (decision.kind) {
    case 'rollOff':
      return (
        <Panel title={`🎲 ${who}: roll for turn order`}>
          <div className="small muted">Highest roll goes first; ties reroll.</div>
          <div className="btn-row">
            <button type="button" className="btn accent" data-testid="roll-off" onClick={() => act({ type: 'rollOff', player: decision.player })}>
              Roll the d6
            </button>
          </div>
        </Panel>
      );

    case 'homeHarvest':
      return (
        <Panel title={`🏡 ${who}: Home Garden harvest`}>
          <div className="btn-row">
            {decision.options.map((take) => (
              <button
                key={take}
                type="button"
                className="btn accent"
                data-testid={`home-harvest-${take}`}
                onClick={() => act({ type: 'homeHarvest', player: decision.player, take })}
              >
                {take === 'wish' ? '✨ Take 1 Wish' : '🧙 Spawn a Gnome'}
              </button>
            ))}
          </div>
        </Panel>
      );

    case 'chooseHarvest':
      return (
        <Panel title={`🌱 ${who}: choose the next harvest`}>
          <div className="small muted">Harvests are mandatory — pick the order. (Highlighted on the board.)</div>
          <div className="btn-col">
            {decision.options.map((s) => (
              <button
                key={s.key}
                type="button"
                className="btn"
                data-testid={`choose-harvest-${s.key}`}
                onClick={() => act({ type: 'chooseHarvest', player: decision.player, sourceKey: s.key })}
              >
                {GARDEN_META[s.gardenType].emoji} {GARDEN_META[s.gardenType].label} at {posStr(s.pos)}
                {s.kind === 'flytrap' ? ' (it attacks!)' : ''}
              </button>
            ))}
          </div>
        </Panel>
      );

    case 'mushroomClones': {
      const buttons = [];
      for (let c = 0; c <= decision.max; c++) {
        buttons.push(
          <button
            key={c}
            type="button"
            className={`btn${c === decision.max ? ' accent' : ''}`}
            data-testid={`mushroom-clones-${c}`}
            onClick={() => act({ type: 'mushroomClones', player: decision.player, count: c })}
          >
            {c === 0 ? 'None' : `Clone ${c}`}
          </button>,
        );
      }
      return (
        <Panel title={`🍄 ${who}: Mushroom at ${posStr(decision.pos)}`}>
          <div className="small muted">How many gnomes to clone (max {decision.max})?</div>
          <div className="btn-row">{buttons}</div>
        </Panel>
      );
    }

    case 'slide':
    case 'tunnel': {
      const verb = decision.kind === 'slide' ? 'Slide' : 'Tunnel';
      return (
        <Panel title={`${decision.kind === 'slide' ? '🧊' : '🕳️'} ${who}: ${verb.toLowerCase()} from ${posStr(decision.from)}`}>
          <div className="small muted">
            Click a highlighted destination on the board
            {decision.context === 'harvest' ? ' (harvest effect — must resolve)' : ''}.
          </div>
          <div className="btn-row">
            {decision.optional && (
              <button type="button" className="btn" data-testid="decline-effect" onClick={() => act({ type: 'declineEffect', player: decision.player })}>
                Decline
              </button>
            )}
          </div>
        </Panel>
      );
    }

    case 'discard':
      return (
        <Panel title={`🗑️ ${who}: discard ${decision.mustDiscard} card${decision.mustDiscard === 1 ? '' : 's'}`}>
          <div className="small muted">Over the hand limit of {state.config.handLimit}.</div>
          <div className="btn-col">
            {legal
              .filter((a) => a.type === 'discardCard')
              .map((a) => (
                <button
                  key={a.type === 'discardCard' ? a.cardId : ''}
                  type="button"
                  className="btn"
                  onClick={() => act(a)}
                >
                  Discard {a.type === 'discardCard' ? cardName(a.cardId) : ''}
                </button>
              ))}
          </div>
        </Panel>
      );

    case 'snailify':
      return (
        <Panel title={`💀 ${who} has been eliminated`}>
          <div className="small">
            Continue as the <b>Immortal Snail</b>? It cannot win, but it can never be destroyed — and it
            devours every garden it slithers over.
          </div>
          <div className="btn-row">
            <button type="button" className="btn accent" onClick={() => act({ type: 'snailify', player: decision.player, accept: true })}>
              🐌 Become the Snail
            </button>
            <button type="button" className="btn" onClick={() => act({ type: 'snailify', player: decision.player, accept: false })}>
              Leave the game
            </button>
          </div>
        </Panel>
      );

    case 'fightRespond':
      // Rendered by the FightPanel; nothing here.
      return null;

    case 'cardResponse':
      return (
        <Panel title={`✋ ${who}: respond to ${cardName(decision.respondingToCard)}?`}>
          <div className="small muted">
            {pname(state, decision.respondingToPlayer)} played <b>{cardName(decision.respondingToCard)}</b>.
            Play Sudden Magic in response, or pass.
          </div>
          <div className="btn-row">
            <button type="button" className="btn" data-testid="respond-pass" onClick={() => act({ type: 'respondPass', player: decision.player })}>
              Pass
            </button>
            {decision.playableCards.map((cardId) => (
              <button
                key={cardId}
                type="button"
                className="btn accent"
                data-testid={`respond-card-${cardId}`}
                onClick={() => onRespondCard(cardId, decision.player)}
              >
                Play {cardName(cardId)}
              </button>
            ))}
          </div>
        </Panel>
      );

    case 'sacrificeGnome':
      return (
        <Panel title={`☠️ ${who}: Magic Drain`}>
          <div className="small muted">
            You started your turn at 0 Wishes — sacrifice one of your gnomes (highlighted on the board, or
            pick below).
          </div>
          <div className="btn-col">
            {legal
              .filter((a) => a.type === 'sacrificeGnome')
              .map((a) => (
                <button
                  key={a.type === 'sacrificeGnome' ? a.unitId : ''}
                  type="button"
                  className="btn"
                  onClick={() => act(a)}
                >
                  {describeAction(state, a)}
                </button>
              ))}
          </div>
        </Panel>
      );

    case 'snailMove':
      return (
        <Panel title={`🐌 ${who}: Snailmaggedon`}>
          <div className="small muted">
            The curse lets your snail slither 1 space during this Harvest Phase. Click a highlighted space,
            or decline.
          </div>
          <div className="btn-row">
            <button type="button" className="btn" data-testid="decline-effect" onClick={() => act({ type: 'declineEffect', player: decision.player })}>
              Stay put
            </button>
          </div>
        </Panel>
      );

    default: {
      // Unknown decision kind (new card mechanics): generic legal actions.
      const d = decision as { kind: string; player: number };
      return (
        <Panel title={`❓ ${who}: ${d.kind}`}>
          <div className="small muted">Choose an option:</div>
          <div className="btn-col">
            {legal.map((a, i) => (
              <button key={i} type="button" className="btn" onClick={() => act(a)}>
                {describeAction(state, a)}
              </button>
            ))}
          </div>
        </Panel>
      );
    }
  }
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="decision-panel" data-testid="decision-panel">
      <div className="panel-title">{title}</div>
      {children}
    </div>
  );
}
