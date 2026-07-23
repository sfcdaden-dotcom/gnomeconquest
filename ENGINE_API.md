# Whimsy Wars — Engine API

The engine (`src/engine`, import via the `src/engine/index.ts` barrel only) is a
**pure, deterministic, serializable state machine**. The UI, the AI and the tests
all sit on the same three functions:

```ts
createGame(options, seed)  → GameState   // validated; throws EngineError('BAD_CONFIG')
getLegalActions(state[, player]) → Action[]
applyAction(state, action) → GameState   // never mutates its input; throws EngineError
```

Support queries: `getPlayerToAct`, `isGameOver`, plus the read-only helpers
re-exported from `helpers.ts` (`posKey`, `unitsAt`, `wishCap`, …) and the card
lookups from `cards.ts` (`getCardDef`, …). The heuristic CPU lives behind
`chooseAiAction(state)` and uses only this public API.

## Module layout

Import from the `src/engine/index.ts` barrel only — the split below is an
implementation detail and may move again.

| File | Responsibility |
|---|---|
| `engine.ts` | public façade: `applyAction`, `isGameOver`, re-exports |
| `actions.ts` | action dispatch + Action-Phase handlers (move/plant/draw/play) |
| `turns.ts` | roll-off, turn start/end, movement legality, `getPlayerToAct` |
| `settle.ts` | the auto-advance loop and its convergence diagnostics |
| `elimination.ts` | eliminations, snailify, win detection |
| `legalActions.ts` | legal-action intents + complete-action analysis expansion |
| `targeting.ts` | phased card targeting: the `cardTargeting` transaction, step options, enumeration |
| `gardens.ts` | harvests, planting, entry effects |
| `fights.ts` | fight resolution (Respond → Roll → Resolve) |
| `cards.ts` | card framework, definitions, the card stack |
| `helpers.ts` | shared queries and draft mutators |
| `setup.ts` / `gardenPresets.ts` / `rng.ts` / `types.ts` | creation, layouts, RNG, types |

Dependencies run one way through the top layer — `engine → {actions, settle,
legalActions} → {targeting, turns} → elimination → {gardens, cards, fights} →
helpers` — so the split introduces no cycles. `targeting.ts` calls the low-level
commit helpers in `cards.ts` / `fights.ts` but is never imported back by them. The rules layer keeps its pre-existing mutual
imports (`cards ↔ fights`, `cards → gardens → fights`): a card can queue a
fight and a fight can play a card, which is inherent to the rules rather than
an artifact of the file layout.

## Core contracts

1. **Purity / immutability.** `applyAction` deep-clones, mutates the clone
   ("the draft"), and returns it. Illegal actions throw `EngineError` with a
   human-readable message and leave the input untouched.
2. **Determinism.** All randomness flows through the mulberry32 state stored in
   `GameState.rngState` (see `rng.ts`). Same seed + same action sequence ⇒
   identical states, always. The AI is also deterministic, so seeded AI-vs-AI
   games replay identically (this is what the smoke tests rely on).
3. **Serializability.** `GameState` is plain JSON-safe data — no functions, no
   class instances, no `Map`/`Set`. Snapshot, diff, persist and replay freely.
   This is also the multiplayer story: a server can own the state and relay
   actions; clients render from the same data.
4. **The interrupt model.** The state is always either (a) idle in the active
   player's Action Phase or (b) waiting on exactly one typed
   `state.pendingDecision` from one player. Nothing else ever blocks.

## The settle loop

After dispatching an action, `applyAction` "settles" — it auto-advances
everything that needs no human input and stops at the next decision or
Action-Phase idle. **Priority order matters** (`settle.ts`):

1. `finished` → done.
2. `pendingDecision` → stop and wait.
3. **Card stack** (`progressCardStack`) — a card played inside any interrupt
   (e.g. a fight Respond window) fully resolves, including its own response
   windows, before the interrupted thing continues.
4. **Live fight** (`progressFight`) — Respond → Roll → Resolve rounds.
5. **Elimination queue** — may surface a `snailify` decision.
6. **Queued fights** — revalidated, then promoted to the live fight.
7. Roll-off → wait; forced turn end (`turnMustEnd`) → end the turn.
8. Harvest Phase (`continueHarvest`) — built lazily at first entry, so a
   turn-start Magic Drain sacrifice resolves *before* harvests.
9. Otherwise: Action Phase, waiting for the active player.

Every branch must make progress, so the loop terminates. `MAX_SETTLE_STEPS`
(1,000) is a bug net, not a rules mechanism: real play settles in single-digit
steps (measured max **6** across 48 complete AI games — Easy/Normal/Hard × 8
seeds × 2- and 4-player). Overrunning it throws
`EngineError('INTERNAL')` carrying a one-line state snapshot — status, phase,
current player, pending decision kind + player, whether a fight is live, card
stack / response queue / fight queue / elimination queue depths, harvest
progress, `turnMustEnd` and the step count — so the stalled branch is
identifiable from the message alone.

## Turn structure

- `startTurn`: expire the player's own "until your next turn" effects
  (Great Wall Of Whimsy, Lost In The Maize), then Magic Drain check
  (0 Wishes + owns a gnome ⇒ `sacrificeGnome` decision), then the Harvest
  Phase (skipped entirely for Snail seats).
- **Harvest Phase**: every qualifying source snapshotted at phase start;
  owner picks resolution order (`chooseHarvest`) when more than one remains;
  sources are revalidated when resolved; gardens entered mid-harvest do not
  harvest this turn.
- **Action Phase**: any number of `move` (each unit 1 orthogonal space per
  turn), `plant`, `drawCard`, `playCard`; then `endTurn`.

## Decisions (`PendingDecision.kind` → answering `Action.type`)

| Decision | Answer(s) |
|---|---|
| `rollOff` | `rollOff` |
| `chooseHarvest` | `chooseHarvest` |
| `homeHarvest` | `homeHarvest` |
| `mushroomClones` | `mushroomClones` |
| `slide` / `tunnel` | `slide` / `tunnel`, `declineEffect` when optional |
| `fightRespond` | `respondPass`, `respondPlayCard` |
| `cardResponse` | `respondPass`, `respondPlayCard` (incl. Nope-Gnome) |
| `cardTargeting` | `selectTarget` (one of `getPendingDecisionOptions`), `cancelTargeting` |
| `discard` | `discardCard` |
| `snailify` | `snailify` |
| `sacrificeGnome` (Magic Drain) | `sacrificeGnome` |
| `snailMove` (Snailmaggedon) | `snailMove`, `declineEffect` |

### The legal-action contract (phased targeting)

**Primary API — `getLegalActionIntents(state[, player]) → Action[]`.** Every
legal move for the player who must act, with card plays left **untargeted**
(one `playCard` / `respondPlayCard` intent per playable card, no `targets`).
Cheap: no combinatorial work. This is what the UI and the AI use.

Targets are chosen **one step at a time**, not built by the caller. Dispatching
a targeted play without `targets` opens a `cardTargeting` decision; the engine
then offers the legal options for the current step only:

```ts
getPendingDecisionOptions(state) → CardTarget[]   // options for the CURRENT step
applyAction(state, { type: 'selectTarget', player, target })   // pick one
applyAction(state, { type: 'cancelTargeting', player })        // back out
```

Each step's options are recomputed from live state (never stored on the
decision, so they can't go stale across a save/load), and later steps are
narrowed by earlier picks: after choosing Plot Twist's first space, the second
step offers only that space's orthogonal neighbours (≤4), not every board-wide
pairing. On the last step the card's own `validate` re-runs on the complete
payload before the card is committed. So the cost of listing options is
proportional to the current decision step, not the product of every slot.

A play that already carries a full `targets` payload is committed in one shot
(re-validated, then played) — this is the path the AI and direct callers use,
so supplying targets up front still works exactly as before.

**Analysis helper — `getLegalActions` / `enumerateCompleteCardActions`.** The
same actions but with every targeted card expanded into complete, immediately
executable actions (one per valid `CardTargets` payload). This is the
**expensive** path — it walks each card's whole targeting flow — and is used
only by tests and offline analysis, never by the UI or the normal AI loop.
Because expansion is phased (each step yields only its own legal options,
narrowed by earlier picks), it is proportional to a card's real branching
(Plot Twist: 2·n·(n-1) adjacent pairs) rather than C(n², k), so there is **no
global combination ceiling** — the old `MAX_TARGET_COMBINATIONS` is gone.

Targeting is card-agnostic in the engine and UI: candidates come from each
card's `targetFlow` steps (see below), and adding a card needs no change to the
enumerator, the action router, or the targeting UI. A step may set
`ordered: true` when pick order is meaningful (Instigation: the first gnome is
the attacker) so the analysis helper emits both orders; otherwise it emits one
canonical order per unordered combination (no reversed duplicates).

**Transaction model.** Playing a card is free, and the card is **not removed
from hand until targeting completes successfully** — so cancelling, or a target
becoming invalid mid-flow, leaves the game exactly as it was (no duplication,
no loss, no double-charge). While a `cardTargeting` decision is open, normal
turn actions and starting another card are blocked, like any other pending
decision. Cancellation is always available and restores whatever preceded the
play (a response window, or the idle Action Phase).

## Cards

Data-driven in `cards.ts`: 23 Whimsy cards × 2 copies + 5 Curses (one joins the
deck per reshuffle, revealed face-up on draw, permanently active). A targeted
card declares a `targetFlow(state, player) → TargetStep[]` — the ordered steps
the engine walks during phased targeting (each step's `getOptions` computes its
legal options from the state and the earlier picks). Once targeting completes
(or a full payload is supplied up front), playing the card moves it hand →
discard and pushes a stack entry; every other `playing` player gets a response
window (auto-passed with nothing playable); the stack resolves LIFO; targets
are validated at completion (throw) and again at resolution (fizzle: logged, no
effect).

Timing: **Sudden** — any time no decision is pending, plus inside Respond
windows; **Ritual** — only the owner's Action Phase. A card flagged
`respondOnly` (Nope-Gnome today) is playable **only** inside `cardResponse`
windows, and never inside fight Respond windows.

Response routing is driven entirely by the card definition, never by card id:

| Flag on `WhimsyCardDef` | Meaning |
|---|---|
| `respondOnly` | playable only inside a `cardResponse` window |
| `targetsRespondedCard` | the router records the responded-to stack index on the stack entry as `respondsToStackIndex`, which the card's `resolve` reads |

Adding a second counter-card therefore needs only these two flags — no change
to the action router (`actions.ts`) or to `cards.ts`'s window handling. See
`responseRouting.test.ts`, which registers a fixture counter-card and proves
the path end to end.

## Rules interpretations ([RULING] decisions the code encodes)

- A garden is **Active** once the global turn it was planted on has ended
  (`gardenIsActive`), matching RULES.md.
- A Maize Garden planted this turn does not tax exits yet (`maizeExitCost`).
- The maize harvest roll is the harvesting OWNER's roll (RULES.md): Snake
  Eyes / 4 Leaf Clover modifiers apply and are consumed. Only the flytrap's
  fight die is a system roll.
- Tunnel *harvest* destinations include "any garden occupied by your own
  gnome", which includes the tunnel itself — choosing it means staying put.
- Movement legality (`moveDestinations` in turns.ts) is the single source of
  truth shared by `doMove`, `getLegalActions` and the Antsy Pants check:
  orthogonal, on-board, not Great-Walled, exit not locked by Lost In The
  Maize, maize exit cost payable.
- Flytraps are never destroyed by fights — stunned until the end of the
  winner's turn. The Immortal Snail is never destroyed; losing a fight on its
  own turn ends that turn (skipping its garden-destruction step).
- Home-capture elimination is checked after all fights on the space resolve.

## Events

`GameState.events` logs every observable state change (`GameEvent`) — the UI
renders its game log and fight playback from it, and tests assert on it. It is
a **rolling window of the most recent 1000 events** (trimmed after each action
so long simulations stay O(actions) instead of O(actions²)); the monotonic
`GameState.eventCount` counts events ever emitted, so consumers diff "events
added by this action" as `next.events.slice(next.events.length -
(next.eventCount - prev.eventCount))`. Add new event kinds as mechanics land,
and give them `describeEvent` text in `src/ui/meta.ts`.

## Errors

All rejections are `EngineError { code }`: `ILLEGAL_ACTION` (not legal now),
`BAD_ARGUMENT` (malformed payload), `BAD_CONFIG` (createGame), `INTERNAL`
(engine invariant broken — always a bug; the settle loop, exhaustiveness
guards and `internal()` calls use it).

## Testing

`src/engine/engine.test.ts` (vitest, `npm test`): config validation,
determinism, serializability, fights, the card stack (incl. Nope-Gnome),
timed-effect expiry, all curse behaviors, and seeded AI-vs-AI full games with
structural invariant checks. Because `GameState` is plain data, tests may
hand-craft scenarios by mutating a cloned state — keep that contract intact.
