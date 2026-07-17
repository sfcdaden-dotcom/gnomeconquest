# Whimsy Wars — Roadmap

Status legend: ✅ done · 🔶 in progress · ⬜ not started

| # | Milestone | Status | Notes |
|---|-----------|--------|-------|
| 1 | **Engine stability** | ✅ | Strict TS, zero warnings; full games run headless; settle loop covers card stack, fights, eliminations, harvests; all 12 decision kinds routable; seeded AI-vs-AI suite green (2026-07-16) |
| 2 | Complete gameplay implementation | ✅ | Rules audit done 2026-07-16 (found & fixed: maize harvest roll now uses the owner's roll, so Snake Eyes/Clover apply). Two open designer questions logged in TECH_DEBT.md |
| 3 | Complete card system | ✅ | All 23 cards + 5 curses implemented, resolvable, and covered by per-card tests (validate/resolve/fizzle, 36 tests in cards.test.ts, 2026-07-16) |
| 4 | AI competency | 🔶 | Card play landed 2026-07-17: the AI now draws (when wish-rich with hand room), plays economy/removal/reinforcement/finisher cards through `planCardPlay` (deterministic target pickers validated against each card's own `validate`), responds in fight windows (Gnomebody-Dies shield vs flytraps, Clover/Snake-Eyes in home-stakes/late fights), Nope-Gnomes lethal cards (Rocket/Mushroom-Cloud on our gnomes), and discards its lowest-value card. 60-game sweep (2p/4p) still terminates (≤541 actions). Remaining: smarter fight commitment, difficulty levels |
| 5 | UI polish | 🔶 | Layout rebalanced 2026-07-16: board fits its slot (column width + dvh clamp + 580px cap) instead of dominating; stable action-bar footer; container-query token scaling (any board size); calmer borders/shadows; stacked-mode overlap fixed. Remaining: animations, mobile layout pass, visual identity beyond emoji |
| 6 | Audio/visual polish | ⬜ | |
| 7 | Save/load games | ⬜ | Engine is already serializable; needs schemaVersion migration policy + UI |
| 8 | Replay support | ⬜ | Record action log alongside seed; replay = re-apply (determinism already tested) |
| 9 | Statistics | ⬜ | Per-player aggregates from event stream |
| 10 | Accessibility | ⬜ | Keyboard-only play, screen-reader labels (board cells already have aria-labels), color-blind palettes |
| 11 | Multiplayer-ready architecture | ⬜ | Server-authoritative applyAction relay; state is plain data by contract |
| 12 | Release candidate | 🔶 | Public-release prep done 2026-07-16 (v1.0.0-rc.1): build-time CSP, security headers, error boundary, host-agnostic relative base, deps audit clean, DEPLOYMENT.md. Remaining human steps: license choice, git init/push, host account + first deploy (see DEPLOYMENT.md checklist) |

## Current focus

**Milestone 12 (partial) — public release prep**: engineering side done
2026-07-16; awaiting the human checklist in DEPLOYMENT.md (license, git,
host account). In parallel, **Milestone 4 — AI competency** is now in
progress: the card-play work item is done (2026-07-17) — the CPU draws, plays,
responds and discards across the whole card system, so cards are no longer
invisible to CPU seats. Verified by dedicated `ai.ts` policy tests plus the
AI-vs-AI smoke suite (games still terminate). Remaining Milestone 4 work:
smarter fight commitment (when to keep feeding a stack fight), difficulty
levels, and desperation-ramp tuning. A few situational cards are still held
rather than played proactively (Great Wall, Sundown Sabotage, Pocket Shovel,
Plot Twist, Gnomio & Juliet, Lost In The Maize) — see TECH_DEBT.md.
