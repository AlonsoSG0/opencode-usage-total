import type { Plugin } from "@opencode-ai/plugin"

export const UsageTotalPlugin: Plugin = async ({ client }) => {
  // W8: the initial load log is awaited so it doesn't become an unhandled
  // rejection, but a log failure must never block plugin load — swallow it.
  try {
    await client.app.log({
      body: {
        service: "usage-total",
        level: "info",
        message: "usage-total plugin loaded",
      },
    })
  } catch {
    /* best-effort: log failure should not block plugin load */
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // W8: high-frequency lifecycle events use "debug" so they don't
        // spam info-level logs; the promise is handled to avoid unhandled
        // rejections instead of being dropped with `void`.
        client.app
          .log({
            body: {
              service: "usage-total",
              level: "debug",
              message: `session.created [${event.properties.info.id}]`,
            },
          })
          .catch(() => {})
      }

      if (event.type === "message.updated") {
        const msg = event.properties.info
        // W8: message.updated fires dozens of times per response, so
        // "debug" keeps info-level logs readable; the promise is handled
        // to avoid unhandled rejections instead of being dropped with `void`.
        client.app
          .log({
            body: {
              service: "usage-total",
              level: "debug",
              message: `message.updated [${msg.id}] role=${msg.role}`,
            },
          })
          .catch(() => {})
      }
    },
  }
}
