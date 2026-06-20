/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createRoot, createSignal } from "solid-js"
import { version } from "./package.json"

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
function resolveRouteSessionID(api: TuiPluginApi): string | undefined {
  const current = api.route.current
  if (current.name === "session") {
    const sid = current.params?.sessionID
    return typeof sid === "string" ? sid : undefined
  }
  return undefined
}

function modelTokens(m: ModelEntry): number {
  return m.tokensInput + m.tokensOutput + m.tokensReasoning
}

function safeNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

// W1: Round accumulated cost to prevent floating-point drift compounding
// over long sessions (0.1 + 0.2 = 0.30000000000000004 in JS). 6 decimal
// places is well below the 4-place display floor, so no visible precision loss.
function roundCost(n: number): number {
  return safeNum(Number(n.toFixed(6)))
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
// C3: module-level init guard. Without this, a reload that happens
// without a prior dispose (loader bug, process crash, or a missing
// onDispose path) stacks a fresh event listener and slot on top of the
// previous ones. Every `message.updated` then runs N handlers, cost /
// tokens accumulate N×, and `saveSession` writes the inflated values to
// KV — corruption that survives restarts because KV persists.
let initialized = false

const tui: TuiPlugin = async (api) => {
  // C3: refuse to re-initialize while a previous instance is active.
  // Returning early is the safest option: no new listener, no new slot,
  // no KV churn. The flag is reset in `cleanup` so a genuine
  // dispose + reload cycle still works.
  if (initialized) {
    api.ui?.toast?.({
      message: "usage-total TUI already loaded; skipping re-init",
      variant: "warning",
    })
    return
  }
  initialized = true

  api.ui?.toast?.({ message: "usage-total TUI loaded", variant: "info" })

  // C4: mutable cleanup handles, declared BEFORE the resources exist.
  // `cleanup` closes over them by reference, so the dispose handler can
  // be registered first and still tear down whatever has been acquired
  // — even if a later step throws partway through initialization.
  let unsub: (() => void) | undefined
  let keymapDispose: (() => void) | undefined
  let solidDispose: (() => void) | undefined
  let flushPending: (() => void) | undefined

  const cleanup = () => {
    try {
      flushPending?.()
    } catch {
      /* best-effort: flush pending KV writes */
    }
    try {
      unsub?.()
    } catch {
      /* best-effort teardown */
    }
    try {
      keymapDispose?.()
    } catch {
      /* best-effort teardown */
    }
    try {
      solidDispose?.()
    } catch {
      /* best-effort teardown */
    }
    initialized = false
  }

  try {
    // C4: register lifecycle disposal FIRST, before acquiring any other
    // resource. If `api.event.on` or `api.slots.register` throws later,
    // the host still invokes this handler and we tear down the listener
    // / keymap layer that were already registered — no partial-init
    // leak. If `onDispose` is unavailable we simply skip it and rely on
    // the try/catch below for partial-init cleanup plus the init guard
    // above for reload safety.
    if (api.lifecycle?.onDispose) {
      api.lifecycle.onDispose(cleanup)
    }

    createRoot((dispose) => {
      // Capture the solid root dispose immediately so a throw later in
      // this callback still leaves `solidDispose` set for `cleanup`.
      solidDispose = dispose

      const [modelState, setModelState] = createSignal<
        Record<string, ModelEntry[]>
      >({})

      // Collapse/expand toggle persisted via KV
      const EXPANDED_KV_KEY = "usage-total.sidebar.expanded"
      const [expanded, setExpanded] = createSignal(
        api.kv?.get?.<boolean>(EXPANDED_KV_KEY, true) !== false,
      )

      // Register keyboard shortcut to toggle section
      const TOGGLE_CMD = "usage-total.toggle-section"
      keymapDispose = api.keymap?.registerLayer
        ? api.keymap.registerLayer({
            commands: [
              {
                name: TOGGLE_CMD,
                title: "Usage: Toggle models section",
                description: "Collapse or expand the models list in the sidebar",
                run: () => {
                  const next = !expanded()
                  setExpanded(next)
                  api.kv?.set?.(EXPANDED_KV_KEY, next)
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

      // W2: Debounce KV writes. `message.updated` fires dozens of times
      // per assistant response; writing to KV on every event is unbounded
      // I/O on the TUI's shared event loop. Instead, mark sessions dirty
      // and flush them in a single batched write after a short idle gap.
      const SAVE_DEBOUNCE_MS = 500
      const dirtySessions = new Set<string>()
      let saveTimer: ReturnType<typeof setTimeout> | undefined

      function flushDirtySessions() {
        if (saveTimer) {
          clearTimeout(saveTimer)
          saveTimer = undefined
        }
        for (const sid of dirtySessions) {
          const models = modelState()[sid]
          if (models && models.length > 0) {
            api.kv?.set?.(kvKey(sid), models)
          }
        }
        dirtySessions.clear()
      }

      // Wire the flush into the dispose path so pending writes survive
      // a proper shutdown (not just a timer tick).
      flushPending = flushDirtySessions

      function scheduleSave(sessionID: string) {
        dirtySessions.add(sessionID)
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(flushDirtySessions, SAVE_DEBOUNCE_MS)
      }

      function loadSession(sessionID: string) {
        if (loadedSessions.has(sessionID)) return
        loadedSessions.add(sessionID)
        const saved = api.kv?.get?.<ModelEntry[]>(kvKey(sessionID))
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
            cost: roundCost(existing.cost + safeCost),
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

        scheduleSave(sessionID)

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
          api.ui?.toast?.({
            message: `${entry.agent}: ${entry.model}`,
            variant: "success",
          })
        }

        // Attribute sub-agent models to the parent session so they
        // appear in the main session sidebar.
        const session = api.state?.session?.get?.(eventSessionID)
        if (session?.parentID && session.parentID !== eventSessionID) {
          upsertModel(session.parentID, entry, cost, tokens)
        }
      }

      unsub = api.event?.on?.("message.updated", (event) => {
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

      api.slots?.register?.({
        order: 200,
        slots: {
          sidebar_content(ctx, props) {
            const sessionID =
              props.session_id ?? resolveRouteSessionID(api) ?? ""
            if (sessionID) loadSession(sessionID)
            const models = sessionID ? (modelState()[sessionID] ?? []) : []

            if (!sessionID || models.length === 0) {
              return (
                <box flexDirection="column">
                  <text fg={ctx.theme.current.text}>
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
              <box flexDirection="column">
                <box
                  flexDirection="row"
                  justifyContent="space-between"
                >
                  <box flexDirection="row">
                    <text fg={ctx.theme.current.text}>
                      {expanded() ? "▼" : "▶"} 🧠 Models
                    </text>
                    <text fg={ctx.theme.current.textMuted}> {version}</text>
                  </box>
                  <text fg={ctx.theme.current.text}>
                    {totalCost > 0
                      ? `${fmtCost(totalCost)} · ${fmtTokens(totalTokens)}`
                      : fmtTokens(totalTokens)}
                  </text>
                </box>
                {expanded() &&
                  models.map((m) => (
                  <box flexDirection="column">
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
    })
  } catch (err) {
    // C4: partial initialization leak guard. Anything acquired before
    // the throw (event listener, keymap layer, solid root) is torn down
    // via `cleanup`, and the init flag is reset so a proper reload can
    // retry instead of being permanently blocked by the guard above.
    cleanup()
    api.ui?.toast?.({
      message: "usage-total TUI failed to initialize",
      variant: "error",
    })
    throw err
  }
}

export default { id: "usage-total", tui }
