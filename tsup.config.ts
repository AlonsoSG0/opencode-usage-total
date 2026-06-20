import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["index.ts", "usage-total.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  dts: false,
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
