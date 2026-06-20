import type { Plugin } from "@opencode-ai/plugin"

export const UsageTotalPlugin: Plugin = async ({ client }) => {
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
