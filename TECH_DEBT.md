# Technical Debt Backlog

Prioritized: **P1** fix next session(s) · **P2** fix within the milestone it
blocks · **P3** opportunistic.

## P1

- ~~**Human players couldn't plant after moving a gnome.**~~ **FIXED
  2026-07-22.** The engine always allowed it (`canPlantAt` never checked
  `movedOnTurn`), but `GameScreen.tsx`'s board-click routing only let you
  re-select a unit that still had a legal *move* — a gnome that had already
  moved dropped out of that list, so its Plant button became permanently
  unreachable for the rest of the turn. Fixed by also treating "has a legal
  plant at this space" as selectable, alongside "has a legal move".
- ~~**AI plays no cards.**~~ **DONE 2026-07-17.** `ai.ts` now draws, plays
  (via `planCardPlay` with per-card deterministic target pickers, each checked
  against the card's own `validate`), responds (`planFightRespond` /
  `planCardResponse`) and discards by static keep-value. Six situational cards
  are still deliberately held (see P3 "AI holds some situational cards").

## P2

- ~~**AI fight-respond enumeration can suggest unplayable-without-targets
  cards.**~~ **FIXED 2026-07-22.** `getLegalActions` now returns only complete,
  executable actions: targeted card plays are expanded into one action per
  valid `CardTargets` payload, enumerated generically from each card's
  `targetSpec` + `validate` (`legalActions.ts`). The cheap untargeted form
  moved to `getLegalActionIntents`, with `getTargetOptions(state, intent)`
  supplying payloads; the AI plans on intents and passes whatever it picks
  through `completeTargets`, so it is now structurally incapable of emitting a
  half-built action. Covered by `legalActions.test.ts`, including a whole-game
  test that dispatches every enumerated action at every state.
- ~~**`respondOnly` cards other than Nope-Gnome are untested territory.**~~
  **FIXED 2026-07-22.** The `cardId === 'nope-gnome'` special case is gone;
  `handleCardResponsePlay` now consults the card definition's
  `targetsRespondedCard` flag and records `respondsToStackIndex` on the stack
  entry (renamed from `nopeTarget`). A second counter-card needs only the two
  flags. `responseRouting.test.ts` registers fixture cards (via the test-only
  `__registerTestCard` seam) and proves the generic path, including that a
  `respondOnly` card *without* the counter flag gets no stack index.
- ~~**Rules audit — remaining open questions.**~~ **RULED 2026-07-22** (bulk
  audit done 2026-07-16 while writing the per-card tests; the maize-roll
  divergence it found is fixed): Center Star wish-cap overflow keeps Wishes
  above 6 until spent (no trim) — designer confirmed the lenient reading is
  correct, no code change. Ritual timing (Action Phase only) — designer
  confirmed correct as implemented; CARDS.md's "any phase" wording already
  matches in practice since the Harvest Phase never idles.
- ~~**AI desperation tuning.**~~ **DONE 2026-07-22 for Hard.** Hard's
  fight-commitment in `scoreDestination` is now a real win-probability
  calculation (gambler's-ruin on the stack-fight rounds — see the function's
  comment) with a bounded late-game push, replacing the flat threshold.
  Normal/Easy deliberately keep the original ad hoc ramp (Normal = no
  regression from before difficulty tiers existed; Easy drops the ramp
  entirely — see the AI difficulty doc comment at the top of `ai.ts`).

## P3

- ~~**Target enumeration is generate-and-filter, so it is quadratic for
  two-space cards**, with a hard `MAX_TARGET_COMBINATIONS` ceiling at 15×15.~~
  **FIXED 2026-07-23** by phased targeting. Cards no longer expand every
  complete `CardTargets` payload up front: a targeted play opens a
  `cardTargeting` decision and the engine offers one step's options at a time
  (`getPendingDecisionOptions`), narrowed by the earlier picks. Listing options
  is now proportional to the current step, not the product of every slot —
  measured **0.012 ms** to list Plot Twist's 49 first-space options on 7×7 and
  **0.014 ms** for its 225 on 15×15 (which the old enumerator refused
  entirely), then ~0.005 ms for the ≤4 second-step neighbours. The full
  cartesian expansion survives only as the off-hot-path analysis helper
  `enumerateCompleteCardActions` (phased, so still bounded by real branching —
  no ceiling). Full-game AI throughput improved (4.39 → 3.07 ms/action) because
  the AI's target-completion fallback walks the flow greedily instead of
  enumerating. The card is not removed from hand until targeting completes, so
  cancelling / invalidation never duplicates, loses or double-charges a card.
  See `targeting.ts`, `targeting.test.ts`, and the two Playwright cases.

  Residual: Pocket Shovel's *complete* enumeration (the analysis helper) is
  still O(area²) — but that is the true size of its legal set (any two empty
  spaces), not a narrowing failure, and it is off every hot path. A three-space
  card would compound it; if one is ever added, cap or lazily page the analysis
  helper rather than the normal phased path.
- **Browser tests cover the happy path only.** `e2e/gameplay.spec.ts` drives
  setup → roll-off → harvest → move → plant → fight → response window → end
  turn on a fixed seed. Not covered: 4-player games, CPU seats, the snail
  path, elimination/end-game overlays, the preset editor, and mobile layout.

- ~~**AI holds some situational cards.**~~ **DONE 2026-07-22 for Hard.**
  `planCardPlay` now has board-state-aware heuristics for all 6 (wall an
  approach, sabotage an occupied economy garden, free tunnels near our own
  gnomes, Plot-Twist a lone home defender out for a free capture, marry two
  of the same opponent's gnomes for a future bonus kill, trap an enemy on
  Maize). Easy/Normal still hold them deliberately — see `isHard` gate in
  `ai.ts`.
- **`scoreDestination` distorts when a friendly gnome shares a square with an
  enemy.** Such co-location can't arise in real play (entry always triggers a
  fight), but the BFS distance field marks the shared square unreachable, so
  any move off it scores ≈+200. Only bites hand-crafted test states; noted so
  future AI tests avoid placing a friendly gnome onto an enemy without a fight.

- **Board size > 7 UI.** Tokens/emoji now scale via container-query units ×
  `--n` (2026-07-16), so 9×9+ renders proportionally — but it has only been
  eyeballed at 7×7; do a visual pass on 9×9/11×11 before exposing board size
  in the setup UI.
- **`GameLog` keys.** Log lines key by window index; with the 1000-event
  rolling window, React keys shift after trim. Cosmetic (append-mostly), fix
  when touching the log UI.
- **Vitest smoke duration.** ~9 full AI games per run. Fine now; if it creeps,
  split into a `test:full` tier and keep 3 games in the default run.
- **schemaVersion policy.** Still `1`; define bump/migration rules before
  save/load (Milestone 7) ships.
- **Optional entry-effect chains are unbounded.** Tunnel→tunnel hops can chain
  indefinitely if a player keeps accepting (each hop is one action, so the
  engine never hangs — the AI declines non-improving hops since 2026-07-16).
  For multiplayer (Milestone 11), consider a [RULING] cap so a griefing client
  can't stall a game.
