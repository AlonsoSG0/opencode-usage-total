import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  // S6: emit TypeScript declaration files (.d.ts) so downstream consumers
  // can type-check against this plugin. Without this, the published package
  // ships JS only and consumers lose all type information.
  dts: true,
  external: [
    "@opencode-ai/plugin",
    "@opentui/core",
    "@opentui/keymap",
    "@opentui/solid",
    "solid-js",
  ],
  esbuildOptions(options) {
    options.jsx = "automatic"
    options.jsxImportSource = "@opentui/solid"
  },
})
