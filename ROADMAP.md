# Whimsy Wars — Roadmap

Status legend: ✅ done · 🔶 in progress · ⬜ not started

| # | Milestone | Status | Notes |
|---|-----------|--------|-------|
| 1 | **Engine stability** | ✅ | Strict TS, zero warnings; full games run headless; settle loop covers card stack, fights, eliminations, harvests; all 12 decision kinds routable; seeded AI-vs-AI suite green (2026-07-16). 2026-07-22: `engine.ts` split by responsibility (actions/turns/settle/elimination/legalActions); `getLegalActions` now returns only complete, executable actions (targets included) with `getLegalActionIntents` + `getTargetOptions` as the cheap two-stage path; response routing driven by card metadata instead of card ids; settle guard cut 100,000 → 1,000 with a full state diagnostic on overrun |
| 2 | Complete gameplay implementation | ✅ | Rules audit done 2026-07-16 (found & fixed: maize harvest roll now uses the owner's roll, so Snake Eyes/Clover apply). Two open designer questions logged in TECH_DEBT.md |
| 3 | Complete card system | ✅ | All 23 cards + 5 curses implemented, resolvable, and covered by per-card tests (validate/resolve/fizzle, 36 tests in cards.test.ts, 2026-07-16) |
| 4 | AI competency | 🔶 | Card play landed 2026-07-17: the AI now draws (when wish-rich with hand room), plays economy/removal/reinforcement/finisher cards through `planCardPlay` (deterministic target pickers validated against each card's own `validate`), responds in fight windows (Gnomebody-Dies shield vs flytraps, Clover/Snake-Eyes in home-stakes/late fights), Nope-Gnomes lethal cards (Rocket/Mushroom-Cloud on our gnomes), and discards its lowest-value card. Difficulty levels landed 2026-07-22: per-seat Easy/Normal/Hard dropdown in Setup; Easy never plays response-window cards and ignores the late-game push; Hard replaces the flat fight-commitment heuristic with a genuine win-probability calculation and plays the 6 previously-held situational cards. Also 2026-07-22: the AI now plants Maize and Tunnel Gardens (previously only Dandelion/Mushroom/Flytrap). 2026-07-23 — positioning fixes: (a) anti-balling — friendly gnomes stacking onto one square is now penalized (spread ~1–2/space, a 3rd only when it buys a fight), so the force fans out toward a target instead of marching as a single ball; (b) economy gardens are built as one home-cluster capped by near-home count (occupancy-independent) instead of replanting each time a holder wandered off — this ends the trail of abandoned Mushroom Gardens, and gnomes now settle onto the cluster to harvest it and dig in to defend it when an enemy closes in. Measured off-home stacks fell to ≤2 and games still terminate. 2026-07-23 — Hard positional rules of thumb: (a) "don't wall yourself in" — Hard no longer plants maize/flytrap by its own home; instead it drops them opportunistically on an enemy's attack lane (a porch square facing us) as a Wish-tax (maize) or forced-detour wall (flytrap, only when the planting gnome can vacate the same turn so its own trap doesn't bite it), see `scoreForwardDeterrent`; (b) "multiple lanes without abandoning the start" — a proactive pincer/spread bias was tried and removed as inert/tempo-negative (see TECH_DEBT.md); the unstoppable-by-one-wall push it wanted already emerges from obstacle-aware routing + anti-balling, while the home-garrison + economy-hold keep a defender back. Remaining: difficulty-aware fight-*response* windows (Hard currently reuses Normal's), Hard tactics beyond fight commitment (e.g. baiting, feints) |
| 5 | UI polish | 🔶 | Layout rebalanced 2026-07-16: board fits its slot (column width + dvh clamp + 580px cap) instead of dominating; stable action-bar footer; container-query token scaling (any board size); calmer borders/shadows; stacked-mode overlap fixed. Remaining: animations, mobile layout pass, visual identity beyond emoji |
| 6 | Audio/visual polish | ⬜ | |
| 7 | Save/load games | ⬜ | Engine is already serializable; needs schemaVersion migration policy + UI |
| 8 | Replay support | ⬜ | Record action log alongside seed; replay = re-apply (determinism already tested) |
| 9 | Statistics | ⬜ | Per-player aggregates from event stream |
| 10 | Accessibility | ⬜ | Keyboard-only play, screen-reader labels (board cells already have aria-labels), color-blind palettes |
| 11 | Multiplayer-ready architecture | ⬜ | Server-authoritative applyAction relay; state is plain data by contract |
| 12 | Release candidate | 🔶 | Public-release prep done 2026-07-16 (v1.0.0-rc.1): build-time CSP, security headers, error boundary, host-agnostic relative base, deps audit clean, DEPLOYMENT.md. 2026-07-22: GitHub Actions CI (`.github/workflows/ci.yml`) runs `npm ci` → lint → test → build plus the Playwright browser suite on every push and PR. Remaining human steps: license choice, git init/push, host account + first deploy (see DEPLOYMENT.md checklist) |

## Current focus

**Milestone 12 (partial) — public release prep**: engineering side done
2026-07-16; awaiting the human checklist in DEPLOYMENT.md (license, git,
host account). In parallel, **Milestone 4 — AI competency** is in progress:
the card-play work item is done (2026-07-17), and 2026-07-22 landed AI
difficulty (Easy/Normal/Hard, per-seat dropdown in Setup), a genuine
win-probability fight-commitment calculation for Hard (replacing the flat
desperation-ramp heuristic for that tier), Hard playing the 6 previously-held
situational cards, and wider AI garden variety (Maize + Tunnel, not just
Dandelion/Mushroom/Flytrap). Verified by dedicated `ai.ts` policy tests plus
Normal and Hard AI-vs-AI smoke suites (games still terminate for both).
Remaining Milestone 4 work: difficulty-aware fight-*response* windows (Hard
currently reuses Normal's Gnomebody-Dies/Clover/Snake-Eyes logic unchanged),
and further Hard-tier tactics beyond fight commitment.
