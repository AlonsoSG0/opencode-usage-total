import type { Plugin } from "@opencode-ai/plugin"

// Server-side plugin. This is the entrypoint opencode loads — without `server()`
// the default export fails validation with "must default export an object with
// server()". The TUI extension (slots, keymap, toasts) lives in
// usage-total-tui.tsx and is merged into the default export by index.ts.
//
// Behavior: logs session/message lifecycle events through the SDK so the user
// has a server-side trail of when a session starts and when messages arrive.
export const UsageTotalServer: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "usage-total",
      level: "info",
      message: "usage-total plugin loaded",
    },
  })

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        void client.app.log({
          body: {
            service: "usage-total",
            level: "info",
            message: `session.created [${event.properties.info.id}]`,
          },
        })
      }

      if (event.type === "message.updated") {
        const msg = event.properties.info
        void client.app.log({
          body: {
            service: "usage-total",
            level: "info",
            message: `message.updated [${msg.id}] role=${msg.role}`,
          },
        })
      }
    },
  }
}
