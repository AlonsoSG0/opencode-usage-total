// TUI entrypoint. Loaded as its own plugin entry via exports["./tui"] —
// separate from index.ts (server) because the validator rejects a single
// default export with both server() and tui().
export { default } from "../usage-total-tui"
