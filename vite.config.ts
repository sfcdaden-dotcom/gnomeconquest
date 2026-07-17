import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Content-Security-Policy for the PRODUCTION bundle, injected at build time
 * only — the dev server needs inline scripts (react fast-refresh preamble)
 * that this policy would block.
 *
 * The app is fully static and self-contained: no network calls, no fonts,
 * no external origins. `style-src 'unsafe-inline'` is required for React
 * inline style attributes (player colors); everything else is locked down.
 * `frame-ancestors` cannot be expressed in a <meta> CSP — it is set in
 * public/_headers for hosts that support header files.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function buildTimeCsp(): Plugin {
  return {
    name: 'whimsy-build-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), buildTimeCsp()],
  // Relative base: the bundle works from any host and any subpath
  // (Cloudflare/Netlify/Vercel at root, GitHub Pages under /repo/).
  base: './',
})
