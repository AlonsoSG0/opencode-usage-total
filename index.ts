// Entry point. Opencode loads this file and expects a default export that
// is an object containing EITHER `server` (Plugin) OR `tui` (TuiPlugin),
// not both — the shared/shared.ts readV1Plugin validator throws
// "must default export either server() or tui(), not both" if both are
// present.
//
// We expose the server here. The TUI extension lives separately in
// tui/index.tsx and is loaded as its own plugin entry.
//
// Layout:
//   usage-total.ts         -> server Plugin (lifecycle event logging)
//   usage-total-tui.tsx    -> TuiPlugin (sidebar slot, alt+m toggle, toasts)
//   index.ts               -> server entrypoint
//   tui/index.tsx          -> tui entrypoint (separate spec)

import { UsageTotalServer } from "./usage-total"

export default {
  id: "usage-total",
  server: UsageTotalServer,
}
