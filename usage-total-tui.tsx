/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createRoot, createSignal } from "solid-js"
import { version } from "./package.json"
import {
  type ModelEntry,
  type ModelEntryKey,
  fmtCost,
  fmtTokens,
  modelTokens,
  roundCost,
  safeNum,
} from "./helpers"

// ---- Constants ----
const DEFAULT_AGENT = "primary"
const UNKNOWN_ID = "?"

// ---- Helpers ----
function resolveRouteSessionID(api: TuiPluginApi): string | undefined {
  const current = api.route.current
  if (current.name === "session") {
    const sid = current.params?.sessionID
    return typeof sid === "string" ? sid : undefined
  }
  return undefined
}

// ---- Plugin ----
// Init guard: without this, a reload without a prior dispose stacks duplicate
// listeners and slots, causing N× accumulation that corrupts persisted KV.
let initialized = false

// Rate-limit new-model toasts to one per 2-second window to prevent toast storms from sub-agent fan-out.
let lastToastTime = 0
// Rate-limit error toasts the same way — a bad stream shouldn't flood the UI.
let lastErrorToastTime = 0

const tui: TuiPlugin = async (api) => {
  // Refuse re-initialization while active. The flag resets in cleanup so dispose+reload still works.
  if (initialized) {
    api.ui?.toast?.({
      message: "usage-total TUI already loaded; skipping re-init",
      variant: "warning",
    })
    return
  }
  initialized = true

  api.ui?.toast?.({ message: "usage-total TUI loaded", variant: "info" })

  // Declare cleanup handles before resources exist so dispose can tear down whatever
  // has been acquired, even if a later step throws partway through initialization.
  let unsub: (() => void) | undefined
  let keymapDispose: (() => void) | undefined
  let solidDispose: (() => void) | undefined
  let flushPending: (() => void) | undefined

  const cleanup = () => {
    try {
      flushPending?.()
    } catch {}
    try {
      unsub?.()
    } catch {}
    try {
      keymapDispose?.()
    } catch {}
    try {
      solidDispose?.()
    } catch {}
    initialized = false
        // Reset the toast cooldowns so a reload doesn't inherit the previous instance's window.
    lastToastTime = 0
    lastErrorToastTime = 0
  }

  try {
    // Register dispose FIRST so the host can tear down partial init even if a later step throws.
    // If onDispose is unavailable, skip and rely on the try/catch + init guard for reload safety.
    if (api.lifecycle?.onDispose) {
      api.lifecycle.onDispose(cleanup)
    }
    // Fall back to AbortSignal when onDispose is unavailable, so dispose still resets
    // the init guard and prevents permanent reload lockout.
    if (!api.lifecycle?.onDispose && api.lifecycle?.signal) {
      api.lifecycle.signal.addEventListener("abort", cleanup, { once: true })
    }

    createRoot((dispose) => {
      solidDispose = dispose

      const [modelState, setModelState] = createSignal<
        Record<string, ModelEntry[]>
      >({})

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

      const loadedSessions = new Set<string>()

      function kvKey(sessionID: string) {
        return `usage-total:models:${sessionID}`
      }

      // Debounce KV writes. session.updated fires dozens of times per response;
      // mark sessions dirty and flush in a single batched write after 500ms of idle.
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
        // Validate KV-loaded data shape. KV is persistent and could hold values from
        // older schemas or corrupted writes.
        if (saved && saved.length > 0) {
          // Validate ALL entries, not just the first. A corrupt entry with non-finite
          // cost/tokens would poison accumulators and silently re-persist on the next
          // debounced save. Reject the entire array if any entry fails, and clear the
          // key so we don't re-evaluate garbage on every render.
          const valid =
            Array.isArray(saved) &&
            saved.every(
              (m) =>
                typeof m?.provider === "string" &&
                typeof m?.model === "string" &&
                typeof m?.agent === "string" &&
                Number.isFinite(m?.cost) &&
                Number.isFinite(m?.tokensInput) &&
                Number.isFinite(m?.tokensOutput) &&
                Number.isFinite(m?.tokensReasoning) &&
                Number.isFinite(m?.tokensCacheRead) &&
                Number.isFinite(m?.tokensCacheWrite),
            )
          if (!valid) {
            api.ui?.toast?.({
              message: "usage-total: discarded corrupt saved model data",
              variant: "warning",
            })
            api.kv?.set?.(kvKey(sessionID), undefined)
            return
          }
          setModelState((current) => ({ ...current, [sessionID]: saved }))
        }
      }

      function upsertModel(
        sessionID: string,
        entry: ModelEntryKey,
        cost: number,
        tokens: {
          input?: number
          output?: number
          reasoning?: number
          cacheRead?: number
          cacheWrite?: number
        },
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
        const safeCacheRead = safeNum(tokens.cacheRead)
        const safeCacheWrite = safeNum(tokens.cacheWrite)

        if (existingIdx >= 0) {
          const existing = sessionModels[existingIdx]
          // session.updated carries accumulative totals — REPLACE, not add.
          sessionModels[existingIdx] = {
            ...existing,
            cost: roundCost(safeCost),
            tokensInput: safeInput,
            tokensOutput: safeOutput,
            tokensReasoning: safeReasoning,
            tokensCacheRead: safeCacheRead,
            tokensCacheWrite: safeCacheWrite,
          }
        } else {
          sessionModels.push({
            ...entry,
            cost: safeCost,
            tokensInput: safeInput,
            tokensOutput: safeOutput,
            tokensReasoning: safeReasoning,
            tokensCacheRead: safeCacheRead,
            tokensCacheWrite: safeCacheWrite,
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
        tokens: {
          input?: number
          output?: number
          reasoning?: number
          cacheRead?: number
          cacheWrite?: number
        },
      ) {
        const isNew = upsertModel(eventSessionID, entry, cost, tokens)
        if (isNew && Date.now() - lastToastTime > 2000) {
          lastToastTime = Date.now()
          api.ui?.toast?.({
            message: `${entry.agent}: ${entry.model}`,
            variant: "success",
          })
        }

        // Walk parent chain to root so sub-agent models appear in the main sidebar,
        // not just the immediate parent. Previous depth-1 logic left grandchildren invisible.
        let cursor = eventSessionID
        const visited = new Set<string>()
        while (true) {
          visited.add(cursor)
          const sess = api.state?.session?.get?.(cursor)
          if (
            !sess?.parentID ||
            sess.parentID === cursor ||
            visited.has(sess.parentID)
          )
            break
          cursor = sess.parentID
        }
        if (cursor !== eventSessionID) {
          upsertModel(cursor, entry, cost, tokens)
        }
      }

      unsub = api.event?.on?.("session.updated", (event) => {
        // Error boundary: catch and toast instead of rethrowing, so a single bad
        // event doesn't kill the subscription for the rest of the session.
        try {
          const info = event?.properties?.info
          const eventSessionID = event?.properties?.sessionID
          if (!info || !eventSessionID) return

          const provider = info.model?.providerID ?? UNKNOWN_ID
          const model = info.model?.id ?? UNKNOWN_ID
          const agent = info.agent ?? DEFAULT_AGENT
          const cost = safeNum(info.cost)
          const tokens = {
            input: safeNum(info.tokens?.input),
            output: safeNum(info.tokens?.output),
            reasoning: safeNum(info.tokens?.reasoning),
            cacheRead: safeNum(info.tokens?.cache?.read),
            cacheWrite: safeNum(info.tokens?.cache?.write),
          }

          trackModel(eventSessionID, { provider, model, agent }, cost, tokens)
        } catch {
          if (Date.now() - lastErrorToastTime > 2000) {
            lastErrorToastTime = Date.now()
            api.ui?.toast?.({
              message: "usage-total: error processing session update",
              variant: "error",
            })
          }
        }
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
    // Partial-init cleanup: tear down anything acquired before the throw, reset the
    // init flag so a proper reload can retry instead of being permanently locked out.
    cleanup()
    api.ui?.toast?.({
      message: "usage-total TUI failed to initialize",
      variant: "error",
    })
    throw err
  }
}

export default { id: "usage-total", tui }
