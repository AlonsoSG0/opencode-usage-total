import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { environment: "node", globals: false },
  esbuild: { jsx: "automatic", jsxImportSource: "@opentui/solid" },
})
