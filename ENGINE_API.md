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
Action-Phase idle. **Priority order matters** (`engine.ts settle()`):

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
| `discard` | `discardCard` |
| `snailify` | `snailify` |
| `sacrificeGnome` (Magic Drain) | `sacrificeGnome` |
| `snailMove` (Snailmaggedon) | `snailMove`, `declineEffect` |

`getLegalActions` enumerates every answer. `playCard` / `respondPlayCard`
actions are enumerated **without targets**; targeted cards additionally need a
`CardTargets` payload satisfying the card's own `validate` (also exposed on the
`WhimsyCardDef` so UIs can pre-check picks).

## Cards

Data-driven in `cards.ts`: 23 Whimsy cards × 2 copies + 5 Curses (one joins the
deck per reshuffle, revealed face-up on draw, permanently active). Playing a
card moves it hand → discard immediately and pushes a stack entry; every other
`playing` player gets a response window (auto-passed with nothing playable);
the stack resolves LIFO; targets are validated at play time (throw) and again
at resolution (fizzle: logged, no effect).

Timing: **Sudden** — any time no decision is pending, plus inside Respond
windows; **Ritual** — only the owner's Action Phase. **Nope-Gnome** — only
inside `cardResponse` windows.

## Rules interpretations ([RULING] decisions the code encodes)

- A garden is **Active** once the global turn it was planted on has ended
  (`gardenIsActive`), matching RULES.md.
- A Maize Garden planted this turn does not tax exits yet (`maizeExitCost`).
- The maize harvest roll is the harvesting OWNER's roll (RULES.md): Snake
  Eyes / 4 Leaf Clover modifiers apply and are consumed. Only the flytrap's
  fight die is a system roll.
- Tunnel *harvest* destinations include "any garden occupied by your own
  gnome", which includes the tunnel itself — choosing it means staying put.
- Movement legality (`moveDestinations` in engine.ts) is the single source of
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
