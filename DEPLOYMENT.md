# Deploying Whimsy Wars

Whimsy Wars is a **fully static, client-only app** — `npm run build` produces a
self-contained `dist/` folder (~86 KB gzipped). There is no backend, no
database, no accounts, no analytics, and the game makes **zero network
requests** after loading. Hosting it means serving three files from any static
host.

## Build

```bash
npm ci
npm test          # 71 tests must pass
npm run build     # tsc -b (strict) && vite build → dist/
npm run preview   # sanity-check the production bundle locally
```

The bundle uses a **relative base path** (`base: './'`), so it works at a
domain root *and* under a subpath (e.g. GitHub Pages' `/repo-name/`).

## Recommended hosts

Any of these free tiers is more than enough. **Cloudflare Pages or Netlify are
preferred** because they honor the `public/_headers` file (full security
headers including `frame-ancestors`, plus immutable caching for hashed
assets).

### Cloudflare Pages / Netlify (recommended)
1. Create the account and a new project (drag-and-drop the `dist/` folder, or
   connect a git repository).
2. If connecting git: build command `npm run build`, output directory `dist`.
3. Done — `_headers` is picked up automatically from the build output.

### GitHub Pages
1. Push the repo to GitHub; enable Pages (deploy from a branch or an Actions
   workflow that runs `npm run build` and publishes `dist/`).
2. Works out of the box thanks to the relative base path.
3. Caveat: Pages ignores `_headers`. The build-time CSP `<meta>` tag still
   applies the script/style/img policy; only `frame-ancestors`/`X-Frame-Options`
   (clickjacking) and cache tuning are lost. Acceptable for a game, but
   header-aware hosts are stricter.

### Vercel
Works the same as Netlify; to get the custom headers, mirror `public/_headers`
into a `vercel.json` `headers` entry (Vercel doesn't read `_headers`).

## Security posture (what's already done)

- **CSP**: injected into `index.html` at build time (dev mode is exempt —
  Vite's dev tooling needs inline scripts): `default-src 'none'` with narrow
  allowances; no external origins of any kind. Mirrored with `frame-ancestors
  'none'` in `_headers`.
- **Headers** (`public/_headers`): `nosniff`, `no-referrer`, frame denial,
  restrictive `Permissions-Policy`, COOP/CORP.
- **No data collection**: no cookies, no localStorage, no telemetry, no
  network calls. The crash screen (ErrorBoundary) logs to the local console
  only.
- **Dependencies**: `npm audit` — 0 vulnerabilities (2026-07-16). Re-run
  before each release.
- **Cheating is out of scope**: the whole game runs client-side; a player
  "hacking" their own single-device game affects only themselves. Real
  anti-cheat arrives with server-authoritative multiplayer (roadmap M11).

## Pre-release checklist (human steps)

- [ ] **Choose a license** and add a `LICENSE` file — nothing is published
      rights-wise until you decide (the repo currently has no license, which
      legally means all-rights-reserved).
- [ ] **Initialize git + push** (`git init`) if deploying via a connected
      repository — also your rollback story.
- [ ] Pick the host, create the account yourself, and deploy `dist/`.
- [ ] After the first deploy: load the site, open devtools, confirm zero
      console errors and that the CSP header/meta is present.
- [ ] Optionally set a custom domain (all hosts above provide HTTPS
      automatically — never serve over plain HTTP).

## Browser support baseline

Evergreen browsers (2023+): the app uses `structuredClone`, CSS `color-mix()`,
container queries, and `dvh` units. No IE/legacy support by design.
