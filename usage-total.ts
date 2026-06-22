import type { Plugin } from "@opencode-ai/plugin"

export const UsageTotalPlugin: Plugin = async ({ client }) => {
  // Await the initial log so rejects are handled; swallow failure so it never blocks plugin load.
  try {
    await client.app.log({
      body: {
        service: "usage-total",
        level: "info",
        message: "usage-total plugin loaded",
      },
    })
  } catch {
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // High-frequency lifecycle events use debug level to avoid spamming info logs.
        // The promise is handled (not dropped with void) to avoid unhandled rejections.
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
