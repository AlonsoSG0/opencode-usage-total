// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createRoot, createSignal } from "solid-js"

// ---- Constants ----
const DEFAULT_AGENT = "primary"
const UNKNOWN_ID = "?"

interface ModelEntry {
  provider: string
  model: string
  agent: string
  cost: number
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  messageCount: number
}

type ModelEntryKey = Omit<
  ModelEntry,
  "cost" | "tokensInput" | "tokensOutput" | "tokensReasoning" | "messageCount"
>

// ---- Helpers ----
function resolveRouteSessionID(api: any): string | undefined {
  return (
    api.route.current.name === "session" &&
    typeof api.route.current.params?.sessionID === "string"
      ? api.route.current.params.sessionID
      : undefined
  )
}

function modelTokens(m: ModelEntry): number {
  return m.tokensInput + m.tokensOutput + m.tokensReasoning
}

function safeNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n === 0) return ""
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

// ---- Plugin ----
const tui: TuiPlugin = async (api) => {
  api.ui.toast({ message: "usage-total TUI loaded", variant: "info" })

  createRoot((dispose) => {
    const [modelState, setModelState] = createSignal<
      Record<string, ModelEntry[]>
    >({})

    // Collapse/expand toggle persisted via KV
    const EXPANDED_KV_KEY = "usage-total.sidebar.expanded"
    const [expanded, setExpanded] = createSignal(
      api.kv.get(EXPANDED_KV_KEY, true) !== false,
    )

    // Register keyboard shortcut to toggle section
    const TOGGLE_CMD = "usage-total.toggle-section"
    const keymapDispose = api.keymap?.registerLayer
      ? api.keymap.registerLayer({
          commands: [
            {
              name: TOGGLE_CMD,
              title: "Usage: Toggle models section",
              description: "Collapse or expand the models list in the sidebar",
              run: () => {
                const next = !expanded()
                setExpanded(next)
                api.kv.set(EXPANDED_KV_KEY, next)
              },
            },
          ],
          bindings: [{ key: "alt+m", cmd: TOGGLE_CMD }],
        })
      : undefined

    // KV persistence – loadedSessions grows with visited sessions,
    // bounded by total session count (not a true leak).
    const loadedSessions = new Set<string>()

    function kvKey(sessionID: string) {
      return `usage-total:models:${sessionID}`
    }

    function saveSession(sessionID: string) {
      const models = modelState()[sessionID]
      if (models && models.length > 0) {
        api.kv.set(kvKey(sessionID), models)
      }
    }

    function loadSession(sessionID: string) {
      if (loadedSessions.has(sessionID)) return
      loadedSessions.add(sessionID)
      const saved = api.kv.get<ModelEntry[]>(kvKey(sessionID))
      if (saved && saved.length > 0) {
        setModelState((current) => ({ ...current, [sessionID]: saved }))
      }
    }

    function upsertModel(
      sessionID: string,
      entry: ModelEntryKey,
      cost: number,
      tokens: { input?: number; output?: number; reasoning?: number },
    ) {
      const dedupeKey = `${entry.provider}/${entry.model}/${entry.agent}`
      const current = modelState()
      const sessionModels = [...(current[sessionID] ?? [])]
      const existingIdx = sessionModels.findIndex(
        (m) => `${m.provider}/${m.model}/${m.agent}` === dedupeKey,
      )

      // Guard against NaN/Infinity that would corrupt accumulators and KV
      const safeCost = safeNum(cost)
      const safeInput = safeNum(tokens.input)
      const safeOutput = safeNum(tokens.output)
      const safeReasoning = safeNum(tokens.reasoning)

      if (existingIdx >= 0) {
        const existing = sessionModels[existingIdx]
        sessionModels[existingIdx] = {
          ...existing,
          cost: safeNum(existing.cost + safeCost),
          tokensInput: safeNum(existing.tokensInput + safeInput),
          tokensOutput: safeNum(existing.tokensOutput + safeOutput),
          tokensReasoning: safeNum(existing.tokensReasoning + safeReasoning),
          messageCount: existing.messageCount + 1,
        }
      } else {
        sessionModels.push({
          ...entry,
          cost: safeCost,
          tokensInput: safeInput,
          tokensOutput: safeOutput,
          tokensReasoning: safeReasoning,
          messageCount: 1,
        })
      }

      setModelState({
        ...current,
        [sessionID]: sessionModels,
      })

      saveSession(sessionID)

      return existingIdx < 0
    }

    function trackModel(
      eventSessionID: string,
      entry: ModelEntryKey,
      cost: number,
      tokens: { input?: number; output?: number; reasoning?: number },
    ) {
      const isNew = upsertModel(eventSessionID, entry, cost, tokens)
      if (isNew) {
        api.ui.toast({
          message: `${entry.agent}: ${entry.model}`,
          variant: "success",
        })
      }

      // Attribute sub-agent models to the parent session so they
      // appear in the main session sidebar.
      const session = api.state.session.get(eventSessionID)
      if (session?.parentID && session.parentID !== eventSessionID) {
        upsertModel(session.parentID, entry, cost, tokens)
      }
    }

    const unsub = api.event.on("message.updated", (event) => {
      const info = event?.properties?.info
      if (!info) return

      const eventSessionID = info.sessionID
      if (!eventSessionID) return

      let provider: string
      let model: string
      let agent: string
      let cost = 0
      let tokens: { input?: number; output?: number; reasoning?: number } = {}

      if (info.role === "user") {
        const mdl = info.model
        provider = mdl?.providerID ?? UNKNOWN_ID
        model = mdl?.modelID ?? UNKNOWN_ID
        agent = info.agent ?? DEFAULT_AGENT
      } else if (info.role === "assistant") {
        provider = info.providerID ?? UNKNOWN_ID
        model = info.modelID ?? UNKNOWN_ID
        agent = info.agent ?? info.mode ?? DEFAULT_AGENT
        cost = safeNum(info.cost)
        tokens = {
          input: safeNum(info.tokens?.input),
          output: safeNum(info.tokens?.output),
          reasoning: safeNum(info.tokens?.reasoning),
        }
      } else {
        return
      }

      trackModel(eventSessionID, { provider, model, agent }, cost, tokens)
    })

    api.slots.register({
      id: "usage-total",
      order: 200,
      slots: {
        sidebar_content(ctx) {
          const sessionID =
            ctx.session_id ?? resolveRouteSessionID(api) ?? ""
          if (sessionID) loadSession(sessionID)
          const models = sessionID ? (modelState()[sessionID] ?? []) : []

          if (!sessionID || models.length === 0) {
            return (
              <box
                flexDirection="column"
                padding={{ left: 1, right: 1, top: 1 }}
              >
                <text fg={ctx.theme.current.text} bold>
                  🧠 Models
                </text>
                <text fg={ctx.theme.current.textMuted}>
                  {sessionID
                    ? "waiting for messages..."
                    : "open a session to track models"}
                </text>
              </box>
            )
          }

          const totalCost = models.reduce((sum, m) => sum + m.cost, 0)
          const totalTokens = models.reduce(
            (sum, m) => sum + modelTokens(m),
            0,
          )

          return (
            <box
              flexDirection="column"
              padding={{ left: 1, right: 1, top: 1 }}
            >
              <box
                flexDirection="row"
                justifyContent="space-between"
              >
                <box flexDirection="row">
                  <text
                    fg={ctx.theme.current.text}
                    bold
                  >
                    {expanded() ? "▼" : "▶"} 🧠 Models
                  </text>
                  <text fg={ctx.theme.current.textMuted}> 0.1.0</text>
                </box>
                <text fg={ctx.theme.current.text}>
                  {totalCost > 0
                    ? `${fmtCost(totalCost)} · ${fmtTokens(totalTokens)}`
                    : fmtTokens(totalTokens)}
                </text>
              </box>
              {expanded() &&
                models.map((m, i) => (
                <box key={i} flexDirection="column">
                  <text fg={ctx.theme.current.text}>
                    {m.agent}:
                  </text>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={ctx.theme.current.text}>
                      {"  " + m.model}
                    </text>
                    <text fg={ctx.theme.current.textMuted}>
                      {m.cost > 0
                        ? `${fmtCost(m.cost)}${modelTokens(m) > 0 ? ` · ${fmtTokens(modelTokens(m))}` : ""}`
                        : modelTokens(m) > 0
                          ? fmtTokens(modelTokens(m))
                          : "-"}
                    </text>
                  </box>
                </box>
              ))}
            </box>
          )
        },
      },
    })

    api.lifecycle.onDispose(() => {
      unsub()
      keymapDispose?.()
      dispose()
    })
  })
}

export default { id: "usage-total", tui }
