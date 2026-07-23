# 🧙 Whimsy Wars 🌼

A digital version of the Whimsy Wars tabletop game: harvest gardens, hoard
Wishes, and gnome your enemies into the compost. 2 or 4 players (any mix of
human hot-seat and CPU, with Easy/Normal/Hard difficulty per seat) on an N×N
garden board — pick a built-in board preset or draw your own in the editor.

- **Rules:** [RULES.md](RULES.md) · **Cards:** [CARDS.md](CARDS.md)
- **Engine API & architecture:** [ENGINE_API.md](ENGINE_API.md)
- **Deploying / hosting:** [DEPLOYMENT.md](DEPLOYMENT.md)
- **Roadmap:** [ROADMAP.md](ROADMAP.md) · **Known debt:** [TECH_DEBT.md](TECH_DEBT.md)

## Getting started

```bash
npm install
npm run dev        # play at the printed localhost URL
npm test           # vitest: unit + seeded AI-vs-AI simulation suite
npm run lint       # oxlint
npm run build      # tsc -b (strict) && vite build

npx playwright install chromium   # once, for the browser tests
npm run test:e2e   # playwright: builds, serves and plays the app in a browser
```

CI (`.github/workflows/ci.yml`) runs all of the above from a clean `npm ci` on
every push and pull request.

## Architecture in one paragraph

`src/engine` is a pure, deterministic, JSON-serializable state machine —
`createGame(options, seed)`, `getLegalActions(state)`, `applyAction(state,
action)` — with all randomness seeded through the state itself (same seed +
same actions ⇒ identical games, always). `src/ui` is a React layer that never
recomputes rules: it renders `GameState`, matches clicks against the engine's
enumerated legal actions, and replays the engine's event log for the game log
and fight animations. The CPU opponent (`chooseAiAction`) uses only the public
engine API. This separation is deliberate: the engine is the future
multiplayer server core, and the test suite drives it through thousands of
actions without any UI.

## Project layout

```
src/engine/   types, RNG, setup, garden presets; the reducer split by
              responsibility (engine facade, actions, turns, settle,
              elimination, legalActions, targeting), gardens, fights,
              cards (data-driven), AI, tests
src/ui/       App shell, setup screen (difficulty + preset picker), game
              screen, board, panels, decision panel, preset editor,
              error boundary, meta text
e2e/          Playwright browser tests (play the real app through the DOM)
RULES.md      tabletop rules (with [RULING] clarifications)
CARDS.md      the 23 Whimsy cards + 5 Curses
ENGINE_API.md engine contracts, settle-loop priorities, decision model
```
