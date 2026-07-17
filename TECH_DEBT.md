# Technical Debt Backlog

Prioritized: **P1** fix next session(s) · **P2** fix within the milestone it
blocks · **P3** opportunistic.

## P1

- ~~**AI plays no cards.**~~ **DONE 2026-07-17.** `ai.ts` now draws, plays
  (via `planCardPlay` with per-card deterministic target pickers, each checked
  against the card's own `validate`), responds (`planFightRespond` /
  `planCardResponse`) and discards by static keep-value. Six situational cards
  are still deliberately held (see P3 "AI holds some situational cards").

## P2

- ~~**AI fight-respond enumeration can suggest unplayable-without-targets
  cards.**~~ Partially addressed: the AI now only ever dispatches
  `respondPlayCard` for cards it can fully target (`four-leaf-clover` /
  `snake-eyes` with a player target / `gnomebody-dies` / `nope-gnome`), so the
  trap no longer bites us. The underlying API sharp edge remains — `getLegalActions`
  still enumerates `respondPlayCard` without targets — so keep the note for any
  future consumer: attach a target-requirement flag or enumerate only
  self-contained cards.
- **`respondOnly` cards other than Nope-Gnome are untested territory.** The
  routing assumes Nope-Gnome is the only respond-only card (`cardId ===
  'nope-gnome'` special case in `handleCardResponsePlay`). Generalize via the
  card def if the designer adds more.
- **Rules audit — remaining open questions** (bulk audit done 2026-07-16 while
  writing the per-card tests; the maize-roll divergence it found is fixed):
  - Center Star wish-cap overflow: leaving the center with 6 Wishes keeps
    them until spent (no trim). Needs a designer ruling; current behavior is
    the lenient reading.
  - Ritual timing: CARDS.md says "own turn (any phase)"; the engine allows
    only the Action Phase — deliberate, since the Harvest Phase never idles
    (documented in ENGINE_API.md), but worth confirming with the designer.
- **AI desperation tuning.** The late-game aggression ramp (`ai.ts
  scoreDestination`) guarantees games end but is untuned; revisit with the
  Milestone 4 heuristics work.

## P3

- **AI holds some situational cards.** `planCardPlay` returns null for Great
  Wall, Sundown Sabotage, Pocket Shovel, Plot Twist, Gnomio & Juliet and Lost
  In The Maize — they need board-state reads (walling a home about to be
  captured, denying a key harvest, offensive marriage cascades) that the first
  heuristic pass skipped. Opportunistic; the AI plays the other 17 cards.
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
