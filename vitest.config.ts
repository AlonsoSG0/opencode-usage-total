import { defineConfig } from "vitest/config"

export default defineConfig({
  // B3: forbid `it.only`/`describe.only` so a focused test can never silently
  // bypass the rest of the suite. Vitest 4 exposes this as `allowOnly`
  // (default `!process.env.CI`); setting it to `false` enforces the guard in
  // every environment — not only when CI is detected — so a stray `.only`
  // can't make a local green run lie about the health of the whole plugin.
  test: { environment: "node", globals: false, allowOnly: false },
  // Vitest 4 uses the oxc transformer (not esbuild); the previous `esbuild`
  // jsx options were silently ignored, which would break JSX in any imported
  // .tsx. Configure oxc directly so `usage-total-tui.tsx` transforms via the
  // @opentui/solid automatic runtime during tests.
  oxc: { jsx: { runtime: "automatic", importSource: "@opentui/solid" } },
})
