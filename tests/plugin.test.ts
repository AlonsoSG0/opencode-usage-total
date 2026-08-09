import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MockInstance } from "vitest"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"

// The plugin's JSX is transformed by oxc into @opentui/solid imports, which pull in a
// terminal renderer that doesn't work in vitest. Stub both runtime variants so sidebar_content
// can run its side effects (loadSession) without crashing. No rendered JSX is tested.
vi.mock("@opentui/solid/jsx-dev-runtime", () => ({
  jsxDEV: () => null,
  Fragment: () => null,
}))
vi.mock("@opentui/solid/jsx-runtime", () => ({
  jsx: () => null,
  jsxs: () => null,
  jsxDEV: () => null,
  Fragment: () => null,
}))

import tuiModule from "../usage-total-tui"
import type { ModelEntry } from "../helpers"

const { tui } = tuiModule

const OPTIONS = undefined
const META = {} as unknown as TuiPluginMeta

// ---- Event shapes (only the fields the handler actually reads) ----
interface MockSessionInfo {
  id?: string
  cost?: number
  agent?: string
  model?: { id?: string; providerID?: string; variant?: string }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}
interface MockSessionUpdatedEvent {
  type?: string
  properties?: { sessionID?: string; info?: MockSessionInfo }
}

function sessionEvent(
  sessionID: string,
  overrides: MockSessionInfo = {},
): MockSessionUpdatedEvent {
  const info = {
    cost: 0.01,
    agent: "primary",
    model: {
      providerID: "anthropic",
      id: "claude-3-7-sonnet",
    },
    tokens: {
      input: 100,
      output: 200,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  }
  // Reflect the new state into the mock's sessionState so the handler can
  // re-read cost/tokens from api.state.session.get() like the real plugin does.
  const mock = (globalThis as Record<string, unknown>).__lastMockApi as
    | {
        sessionState?: Map<string, typeof info>
        sessionMessages?: Map<string, Array<typeof info & { role: string }>>
      }
    | undefined
  if (mock?.sessionState) mock.sessionState.set(sessionID, info)
  // sessionEvent represents a stream of step-finishes for one assistant turn.
  // Each event appends a new assistant message whose tokens and cost are
  // independent — the real plugin uses the LATEST assistant message's tokens
  // as context size and the SUM of all message costs as total cost, so the
  // mock needs to keep every message in the array.
  if (mock?.sessionMessages) {
    const list = mock.sessionMessages.get(sessionID) ?? []
    list.push({ ...info, role: "assistant" })
    mock.sessionMessages.set(sessionID, list)
  }
  return {
    type: "session.updated",
    properties: {
      sessionID,
      info,
    },
  }
}

// Module-level state tracking. initialized and lastToastTime live at module scope,
// so we must tear down after each test or the init guard locks out the next one.
// activeCleanup covers the onDispose path; activeAbort covers the AbortSignal path.
let activeCleanup: (() => void) | undefined
let activeAbort: AbortController | undefined

interface MockApi {
  api: TuiPluginApi
  kvGet: MockInstance<(key: string, fb?: unknown) => unknown>
  kvSet: MockInstance<(key: string, value: unknown) => void>
  toast: MockInstance<(input: { message: string; variant?: string }) => void>
  sessionGet: MockInstance<
    (id: string) => { parentID?: string } | undefined
  >
  eventOn: MockInstance<
    (type: string, handler: (e: unknown) => void) => () => void
  >
  slotsRegister: MockInstance<(plugin: unknown) => string>
  keymapRegisterLayer: MockInstance<(config: unknown) => () => void>
  onDispose: MockInstance<(fn: () => void) => () => void> | undefined
  abortController: AbortController
  sessionState: Map<
    string,
    {
      parentID?: string
      cost?: number
      agent?: string
      model?: { id?: string; providerID?: string; variant?: string }
      tokens?: {
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
      }
    }
  >
  sessionParents: Map<string, string>
  sessionMessages: Map<
    string,
    Array<{
      role: string
      cost?: number
      model?: { id?: string; providerID?: string; variant?: string }
      tokens?: {
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
      }
    }>
  >
}

function makeMockApi(opts: { withOnDispose?: boolean } = {}): MockApi {
  const kvGet = vi.fn<(key: string, fb?: unknown) => unknown>(() => undefined)
  const kvSet = vi.fn<(key: string, value: unknown) => void>()
  const toast = vi.fn<(input: { message: string; variant?: string }) => void>()
  // sessionState mirrors opencode's TuiState.session: a map sessionID -> Session.
  // The handler under test reads cost/tokens/model/agent from this state, not
  // from event payloads, so the mock needs to track it.
  const sessionState = new Map<
    string,
    {
      parentID?: string
      cost?: number
      agent?: string
      model?: { id?: string; providerID?: string; variant?: string }
      tokens?: {
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
      }
    }
  >()
  // sessionParents is layered on top of sessionState for walk tests: the
  // sessionEvent helper writes cost/tokens, while walk tests populate
  // sessionParents with the chain. sessionGet merges both so handlers see
  // a single coherent state.
  const sessionParents = new Map<string, string>()
  // sessionMessages mirrors `api.state.session.messages(id)` in the real TUI.
  // The handler reads the last assistant message's tokens (context size) and
  // sums every assistant message's cost (total cost) — see lastAssistantWithTokens
  // and sumAssistantCost in helpers.ts. sessionEvent appends one entry per call.
  const sessionMessages = new Map<
    string,
    Array<{
      role: string
      cost?: number
      model?: { id?: string; providerID?: string; variant?: string }
      tokens?: {
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
      }
    }>
  >()
  const sessionGet = vi.fn<
    (id: string) => { parentID?: string } | undefined
  >((id) => {
    const fromState = sessionState.get(id)
    const parentID = sessionParents.get(id)
    if (!fromState && !parentID) return undefined
    return { ...(fromState ?? {}), ...(parentID ? { parentID } : {}) }
  })
  const sessionMessagesGet = vi.fn<
    (id: string) => ReadonlyArray<{
      role: string
      cost?: number
      tokens?: {
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
      }
    }>
  >((id) => sessionMessages.get(id) ?? [])
  const eventOn = vi.fn<
    (type: string, handler: (e: unknown) => void) => () => void
  >(() => () => {})
  const slotsRegister = vi.fn<(plugin: unknown) => string>(() => "")
  const keymapRegisterLayer = vi.fn<(config: unknown) => () => void>(
    () => () => {},
  )
  const abortController = new AbortController()
  activeAbort = abortController
  const onDispose =
    opts.withOnDispose === false
      ? undefined
      : vi.fn<(fn: () => void) => () => void>((fn) => {
          activeCleanup = fn
          return () => {}
        })

  const api = {
    kv: { get: kvGet, set: kvSet, ready: true },
    ui: { toast },
    lifecycle: { onDispose, signal: abortController.signal },
    state: {
      session: {
        get: sessionGet,
        messages: sessionMessagesGet,
        state: sessionState,
      },
    },
    event: { on: eventOn },
    slots: { register: slotsRegister },
    keymap: { registerLayer: keymapRegisterLayer },
    route: {
      current: { name: "home" },
      register: vi.fn(),
      navigate: vi.fn(),
    },
  } as unknown as TuiPluginApi

  // Expose the session state to module-level helpers like sessionEvent() so
  // they can mirror the latest info into api.state without the test having
  // to thread the mock through every call site.
  ;(globalThis as Record<string, unknown>).__lastMockApi = {
    sessionState,
    sessionParents,
    sessionMessages,
  }

  return {
    api,
    kvGet,
    kvSet,
    toast,
    sessionGet,
    eventOn,
    slotsRegister,
    keymapRegisterLayer,
    onDispose,
    abortController,
    sessionState,
    sessionParents,
    sessionMessages,
  }
}

// ---- Captured-resource accessors ----
// The plugin registers three handlers (session.updated, message.updated,
// session.idle). Look the handler up by event name instead of returning the
// last registration — the last one is session.idle, which silently made every
// test that called getHandler() exercise the idle handler while claiming to
// test session.updated.
function getHandler(
  m: MockApi,
  event: "session.updated" | "message.updated" | "session.idle" = "session.updated",
): ((e: MockSessionUpdatedEvent) => void) | undefined {
  const call = m.eventOn.mock.calls.find(([type]) => type === event)
  return call?.[1] as ((e: MockSessionUpdatedEvent) => void) | undefined
}

type SidebarRender = (
  ctx: { theme: { current: { text: string; textMuted: string } } },
  props: { session_id?: string },
) => unknown

function getSidebarRender(m: MockApi): SidebarRender | undefined {
  const calls = m.slotsRegister.mock.calls
  const last = calls[calls.length - 1]
  if (!last) return undefined
  const plugin = last[0] as {
    slots: { sidebar_content: SidebarRender }
  }
  return plugin.slots.sidebar_content
}

function kvKey(sessionID: string): string {
  return `usage-total:models:${sessionID}`
}

function modelsSavedFor(
  m: MockApi,
  sessionID: string,
): ModelEntry[] | undefined {
  const call = m.kvSet.mock.calls.find(([k]) => k === kvKey(sessionID))
  return call?.[1] as ModelEntry[] | undefined
}

function init(m: MockApi): Promise<void> {
  return tui(m.api, OPTIONS, META)
}

const CTX = { theme: { current: { text: "#fff", textMuted: "#888" } } }

// ---- Global timer/cleanup setup ----
beforeEach(() => {
  // Fake timer APIs + Date so the toast cooldown (Date.now() - lastToastTime > 2000) is deterministic.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"))
  activeCleanup = undefined
  activeAbort = undefined
})

afterEach(() => {
  // Tear down whichever disposal path the plugin used. Calling an already-run cleanup
  // is idempotent; aborting a controller with no listener is a no-op.
  try {
    activeCleanup?.()
  } catch {}
  try {
    activeAbort?.abort()
  } catch {}
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// =====================================================================
// Init guard
// =====================================================================
describe("init guard", () => {
  it("initializes on first call and registers all resources", async () => {
    const m = makeMockApi()
    await init(m)

    expect(m.slotsRegister).toHaveBeenCalledTimes(1)
    // Three event subscriptions: session.updated, message.updated, session.idle.
    expect(m.eventOn).toHaveBeenCalledTimes(3)
    expect(m.eventOn.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["session.updated", "message.updated", "session.idle"]),
    )
    expect(m.keymapRegisterLayer).toHaveBeenCalledTimes(1)
    expect(m.onDispose).toHaveBeenCalledTimes(1)
    expect(
      m.toast.mock.calls.some(
        (c) =>
          c[0].message === "usage-total TUI loaded" &&
          c[0].variant === "info",
      ),
    ).toBe(true)
  })

  it("refuses to re-initialize while active (skips re-registration)", async () => {
    const first = makeMockApi()
    await init(first)
    expect(first.slotsRegister).toHaveBeenCalledTimes(1)

    // A second invocation on a fresh api must bail out via the guard and
    // leave no new listeners/slots behind.
    const second = makeMockApi()
    await init(second)

    expect(second.slotsRegister).not.toHaveBeenCalled()
    expect(second.eventOn).not.toHaveBeenCalled()
    expect(second.keymapRegisterLayer).not.toHaveBeenCalled()
    expect(
      second.toast.mock.calls.some(
        (c) =>
          c[0].message === "usage-total TUI already loaded; skipping re-init" &&
          c[0].variant === "warning",
      ),
    ).toBe(true)
    // The first instance is untouched — no double registration.
    expect(first.slotsRegister).toHaveBeenCalledTimes(1)
  })

  it("can re-initialize after cleanup resets the guard", async () => {
    const first = makeMockApi()
    await init(first)
    expect(first.onDispose).toHaveBeenCalledTimes(1)
    // Simulate a real dispose: the onDispose handler is the plugin's cleanup.
    activeCleanup?.()
    // The same module can now boot a fresh instance.
    const second = makeMockApi()
    await init(second)

    expect(second.slotsRegister).toHaveBeenCalledTimes(1)
    // Three event subscriptions: session.updated, message.updated, session.idle.
    expect(second.eventOn).toHaveBeenCalledTimes(3)
    expect(
      second.toast.mock.calls.some(
        (c) => c[0].message === "usage-total TUI loaded",
      ),
    ).toBe(true)
  })
})

// =====================================================================
// Debounce + flush
// =====================================================================
describe("debounce + flush", () => {
  it("collapses rapid scheduleSave calls into a single KV write", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    // Three rapid events for the same session — session.updated carries accumulative
    // totals so upsertModel REPLACES. The last event wins; debounce collapses to one write.
    handler(sessionEvent("s1", { cost: 0.01, tokens: { input: 100, output: 200 } }))
    handler(sessionEvent("s1", { cost: 0.02, tokens: { input: 200, output: 400 } }))
    handler(sessionEvent("s1", { cost: 0.03, tokens: { input: 300, output: 600 } }))

    expect(m.kvSet).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)

    const writes = m.kvSet.mock.calls.filter(([k]) => k === kvKey("s1"))
    expect(writes).toHaveLength(1)
    const models = writes[0][1] as ModelEntry[]
    expect(models).toHaveLength(1)
    // Tokens from the last message (third event); cost is the SUM of all three
    // messages' costs because that's how the opencode app reports totalCost.
    expect(models[0].tokensInput).toBe(300)
    expect(models[0].tokensOutput).toBe(600)
    expect(models[0].cost).toBeCloseTo(0.06, 10)
  })

  it("cleanup flushes pending writes before teardown", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("s1"))
    // Not yet flushed — debounce timer hasn't fired.
    expect(m.kvSet).not.toHaveBeenCalled()

    // Dispose triggers flushPending — data reaches KV even without timer tick.
    activeCleanup?.()
    expect(modelsSavedFor(m, "s1")).toBeDefined()
    expect(modelsSavedFor(m, "s1")!).toHaveLength(1)
  })
})

// =====================================================================
// Parent-chain attribution (walk)
// =====================================================================
describe("parent-chain attribution", () => {
  it("attributes a depth-1 sub-agent to the root session", async () => {
    const m = makeMockApi()
    m.sessionParents.set("sub", "root")
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("sub"))
    vi.advanceTimersByTime(500)

    // Tracked on the event session AND walked up to root.
    expect(modelsSavedFor(m, "sub")).toBeDefined()
    expect(modelsSavedFor(m, "root")).toBeDefined()
    expect(modelsSavedFor(m, "root")!).toHaveLength(1)
    expect(modelsSavedFor(m, "root")![0].model).toBe("claude-3-7-sonnet")
    // Walked entry uses the `sub:` prefix so it never collides with a real
    // root entry that happens to share provider/model/agent.
    expect(modelsSavedFor(m, "root")![0].agent).toBe("sub:primary")
  })

  it("attributes a depth-2 grandchild to the root session", async () => {
    const m = makeMockApi()
    m.sessionParents.set("grandchild", "child")
    m.sessionParents.set("child", "root")
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("grandchild"))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "grandchild")).toBeDefined()
    expect(modelsSavedFor(m, "root")).toBeDefined()
    expect(modelsSavedFor(m, "child")).toBeUndefined()
    expect(modelsSavedFor(m, "root")![0].agent).toBe("sub:primary")
  })

  it("sub-agent with the same agent name does not overwrite the root entry", async () => {
    // Without the `sub:` prefix, a sub-agent running as agent "primary" would
    // dedupeKey-collision with the root's own "primary" entry and the walk
    // would REPLACE the root's cost/tokens with the sub-agent's. The render
    // would then sum the sub-agent's cost on top of the root's, double-counting.
    const m = makeMockApi()
    m.sessionParents.set("sub", "root")
    await init(m)
    const handler = getHandler(m)!

    // Root processes its own LLM call first.
    handler(
      sessionEvent("root", {
        cost: 0.5,
        tokens: { input: 1000, output: 2000 },
        agent: "primary",
      }),
    )
    // Then a sub-agent runs with the same agent name "primary".
    handler(
      sessionEvent("sub", {
        cost: 0.3,
        tokens: { input: 500, output: 1000 },
        agent: "primary",
      }),
    )
    vi.advanceTimersByTime(500)

    const root = modelsSavedFor(m, "root")!
    // Both entries coexist: root's "primary" stays intact, sub-agent's "primary"
    // is parked under the `sub:primary` key.
    expect(root).toHaveLength(2)
    const byAgent = Object.fromEntries(root.map((m) => [m.agent, m]))
    expect(byAgent["primary"].cost).toBe(0.5)
    expect(byAgent["primary"].tokensInput).toBe(1000)
    expect(byAgent["sub:primary"].cost).toBe(0.3)
    expect(byAgent["sub:primary"].tokensInput).toBe(500)
  })

  it("self-referencing parentID does not loop", async () => {
    const m = makeMockApi()
    m.sessionParents.set("self", "self")
    await init(m)
    const handler = getHandler(m)!

    // parentID same as sessionID — breaks immediately, no root attribution.
    handler(sessionEvent("self"))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "self")).toBeDefined()
    // Only one write total (no extra root write, no infinite loop).
    expect(m.kvSet.mock.calls.filter(([k]) => k === kvKey("self"))).toHaveLength(1)
  })

  it("cyclic parent chain terminates via the visited set", async () => {
    const m = makeMockApi()
    m.sessionParents.set("a", "b")
    m.sessionParents.set("b", "a")
    await init(m)
    const handler = getHandler(m)!

    // a -> b -> a(cycle). Walk stops at b; b != a so it's attributed to b.
    handler(sessionEvent("a"))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "a")).toBeDefined()
    expect(modelsSavedFor(m, "b")).toBeDefined()
    // Terminated: no throw, no infinite loop, exactly one write per session.
    expect(m.kvSet.mock.calls.filter(([k]) => k === kvKey("a"))).toHaveLength(1)
    expect(m.kvSet.mock.calls.filter(([k]) => k === kvKey("b"))).toHaveLength(1)
  })

  it("nil parent stays attributed to the event session only", async () => {
    const m = makeMockApi()
    // session.get returns undefined -> no parentID -> no walk.
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("solo"))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "solo")).toBeDefined()
    expect(m.kvSet.mock.calls).toHaveLength(1)
  })

  it("parallel sub-agents with the same provider/model/agent keep separate root entries", async () => {
    // Two sub-agents that both run the same model as agent "primary" walk up to
    // root with the same `sub:primary` dedupe key. Without sourceSessionID they
    // would REPLACE each other and the root total would understate the tree.
    const m = makeMockApi()
    m.sessionParents.set("subA", "root")
    m.sessionParents.set("subB", "root")
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("subA", { cost: 0.1, tokens: { input: 100, output: 200 } }))
    handler(sessionEvent("subB", { cost: 0.2, tokens: { input: 300, output: 400 } }))
    vi.advanceTimersByTime(500)

    const root = modelsSavedFor(m, "root")!
    const subEntries = root.filter((e) => e.agent === "sub:primary")
    // Both sub-agents coexist instead of one clobbering the other.
    expect(subEntries).toHaveLength(2)
    expect(subEntries.map((e) => e.cost).sort()).toEqual([0.1, 0.2])
    // Each is tagged with its own origin session.
    expect(new Set(subEntries.map((e) => e.sourceSessionID)).size).toBe(2)
  })
})

// =====================================================================
// session.updated handler
// =====================================================================
describe("session.updated handler", () => {
  it("tracks a valid session event into state", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("s1"))
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      agent: "primary",
      cost: 0.01,
      tokensInput: 100,
      tokensOutput: 200,
    })
  })

  it("ignores a malformed event with no info", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler({ type: "session.updated", properties: {} })
    vi.advanceTimersByTime(500)

    expect(m.kvSet).not.toHaveBeenCalled()
  })

  it("ignores a malformed event with no sessionID", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler({
      type: "session.updated",
      properties: {
        info: { agent: "primary", model: { providerID: "anthropic" } },
      },
    })
    vi.advanceTimersByTime(500)

    expect(m.kvSet).not.toHaveBeenCalled()
  })

  it("catches a throwing handler without killing the subscription", async () => {
    const m = makeMockApi()
    // First session.get throws (simulates a state-layer failure inside the walk).
    // Subsequent calls use the default (read from sessionState) so a later event works.
    m.sessionGet.mockImplementationOnce(() => {
      throw new Error("state layer down")
    })
    await init(m)
    const handler = getHandler(m)!

    // This event's first read throws → caught → error toast, but the listener stays alive.
    handler(sessionEvent("s1"))
    expect(
      m.toast.mock.calls.some(
        (c) =>
          c[0].message === "usage-total: error processing session update" &&
          c[0].variant === "error",
      ),
    ).toBe(true)

    // A second, healthy event is still processed by the same subscription.
    handler(sessionEvent("s1", { model: { providerID: "anthropic", id: "claude-haiku" } }))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "s1")).toBeDefined()
  })

  it("replaces cost on duplicate session events (streaming updates)", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("s1", { cost: 0.01, tokens: { input: 100, output: 200 } }))
    handler(sessionEvent("s1", { cost: 0.05, tokens: { input: 200, output: 400 } }))
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models).toHaveLength(1)
    // Tokens from the last message; cost is the sum across messages.
    expect(models[0].tokensInput).toBe(200)
    expect(models[0].tokensOutput).toBe(400)
    expect(models[0].cost).toBeCloseTo(0.06, 10)
  })
})

// =====================================================================
// upsertModel
// =====================================================================
describe("upsertModel", () => {
  it("adds a new model to state", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("s1"))
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models).toHaveLength(1)
    expect(models[0].model).toBe("claude-3-7-sonnet")
  })

  it("replaces tokens but accumulates cost across messages (matches opencode app)", async () => {
    // The plugin mirrors the official opencode app: tokens come from the
    // LAST assistant message (context size of the most recent turn), and
    // cost is the SUM of every assistant message's cost (total cost).
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(sessionEvent("s1", { cost: 0.01, tokens: { input: 100, output: 200 } }))
    handler(sessionEvent("s1", { cost: 0.02, tokens: { input: 200, output: 400 } }))
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models).toHaveLength(1)
    // Tokens are from the last message (context size).
    expect(models[0].tokensInput).toBe(200)
    expect(models[0].tokensOutput).toBe(400)
    // Cost is the sum of every assistant message.
    expect(models[0].cost).toBeCloseTo(0.03, 10)
  })

  it("sanitizes NaN/Infinity cost and tokens to 0", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(
      sessionEvent("s1", {
        cost: NaN,
        tokens: { input: Infinity, output: 200 },
      }),
    )
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models[0].cost).toBe(0)
    expect(models[0].tokensInput).toBe(0)
    expect(models[0].tokensOutput).toBe(200)
  })
})

// =====================================================================
// loadSession KV validation
// =====================================================================
describe("loadSession validation (B2)", () => {
  function validEntry(over: Partial<ModelEntry> = {}): ModelEntry {
    return {
      provider: "openai",
      model: "gpt-4o",
      agent: "primary",
      cost: 0.5,
      tokensInput: 1000,
      tokensOutput: 500,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      ...over,
    }
  }

  it("loads a valid saved array into state", async () => {
    const m = makeMockApi()
    const saved = [validEntry()]
    m.kvGet.mockImplementation((key) =>
      key === kvKey("s1") ? saved : undefined,
    )
    await init(m)
    const render = getSidebarRender(m)!

    render(CTX, { session_id: "s1" })

    // Accepted: no KV clear, no warning toast.
    expect(
      m.kvSet.mock.calls.some(
        ([k, v]) => k === kvKey("s1") && v === undefined,
      ),
    ).toBe(false)
    expect(
      m.toast.mock.calls.some(
        (c) => c[0].variant === "warning",
      ),
    ).toBe(false)

    // The loaded array is actually in state: a new event for the same
    // session (different model) accumulates alongside the loaded entry.
    const handler = getHandler(m)!
    handler(sessionEvent("s1", { model: { providerID: "anthropic", id: "claude-3-7-sonnet" } }))
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models).toHaveLength(2)
    expect(models.some((x) => x.model === "gpt-4o")).toBe(true)
    expect(models.some((x) => x.model === "claude-3-7-sonnet")).toBe(true)
  })

  it("rejects a non-array value and clears KV", async () => {
    const m = makeMockApi()
    // A string is truthy with .length > 0 but is not an array -> rejected.
    m.kvGet.mockImplementation((key) =>
      key === kvKey("s1") ? "corrupt" : undefined,
    )
    await init(m)
    const render = getSidebarRender(m)!

    render(CTX, { session_id: "s1" })

    expect(
      m.kvSet.mock.calls.some(
        ([k, v]) => k === kvKey("s1") && v === undefined,
      ),
    ).toBe(true)
    expect(
      m.toast.mock.calls.some(
        (c) =>
          c[0].message === "usage-total: discarded corrupt saved model data" &&
          c[0].variant === "warning",
      ),
    ).toBe(true)
  })

  it("rejects an array with a corrupt entry and clears KV", async () => {
    const m = makeMockApi()
    // First entry fine, second has a non-string provider → whole array
    // rejected (every entry is validated, not just the first).
    const saved = [
      validEntry(),
      validEntry({ provider: 123 as unknown as string, model: "bad" }),
    ]
    m.kvGet.mockImplementation((key) =>
      key === kvKey("s1") ? saved : undefined,
    )
    await init(m)
    const render = getSidebarRender(m)!

    render(CTX, { session_id: "s1" })

    expect(
      m.kvSet.mock.calls.some(
        ([k, v]) => k === kvKey("s1") && v === undefined,
      ),
    ).toBe(true)
    expect(
      m.toast.mock.calls.some((c) => c[0].variant === "warning"),
    ).toBe(true)
  })

  it("rejects an array with a NaN cost and clears KV", async () => {
    const m = makeMockApi()
    const saved = [validEntry({ cost: NaN })]
    m.kvGet.mockImplementation((key) =>
      key === kvKey("s1") ? saved : undefined,
    )
    await init(m)
    const render = getSidebarRender(m)!

    render(CTX, { session_id: "s1" })

    expect(
      m.kvSet.mock.calls.some(
        ([k, v]) => k === kvKey("s1") && v === undefined,
      ),
    ).toBe(true)
    expect(
      m.toast.mock.calls.some((c) => c[0].variant === "warning"),
    ).toBe(true)
  })
})

// =====================================================================
// KV load on the event path (fix: no clobber for unrendered sessions)
// =====================================================================
describe("KV load on the event path", () => {
  it("loads persisted KV for a session that never rendered before upserting", async () => {
    const m = makeMockApi()
    // KV already holds one persisted entry for s1, but s1 is never rendered.
    const saved: ModelEntry[] = [
      {
        provider: "openai",
        model: "gpt-4o",
        agent: "primary",
        cost: 0.5,
        tokensInput: 1000,
        tokensOutput: 500,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
      },
    ]
    m.kvGet.mockImplementation((key) =>
      key === kvKey("s1") ? saved : undefined,
    )
    await init(m)

    // An event fires for a background/unrendered session. No render call at all.
    const handler = getHandler(m)!
    handler(
      sessionEvent("s1", {
        model: { providerID: "anthropic", id: "claude-3-7-sonnet" },
      }),
    )
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    // If loadSession hadn't run on the event path, the upsert would start from
    // empty in-memory state and the flush would overwrite persisted KV with a
    // partial array containing only the new entry.
    expect(models).toHaveLength(2)
    expect(models.some((x) => x.model === "gpt-4o")).toBe(true)
    expect(models.some((x) => x.model === "claude-3-7-sonnet")).toBe(true)
  })

  it("loads persisted KV for all three event handlers", async () => {
    const m = makeMockApi()
    const saved: ModelEntry[] = [
      {
        provider: "openai",
        model: "gpt-4o",
        agent: "primary",
        cost: 0.5,
        tokensInput: 1000,
        tokensOutput: 500,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
      },
    ]
    m.kvGet.mockImplementation((key) =>
      key === kvKey("s1") ? saved : undefined,
    )
    await init(m)

    // The same session never rendered; each handler must still merge its upsert
    // on top of the persisted entry, not replace it.
    getHandler(m, "message.updated")!(sessionEvent("s1"))
    getHandler(m, "session.idle")!(sessionEvent("s1"))
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models).toHaveLength(2)
    expect(models.some((x) => x.model === "gpt-4o")).toBe(true)
  })
})

// =====================================================================
// onDispose fallback via AbortSignal
// =====================================================================
describe("onDispose fallback via AbortSignal", () => {
  it("resets the init guard via the AbortSignal when onDispose is missing", async () => {
    const first = makeMockApi({ withOnDispose: false })
    await init(first)

    expect(first.onDispose).toBeUndefined()
    // With onDispose missing, cleanup rides on the lifecycle AbortSignal.
    first.abortController.abort()

    // A fresh instance can boot because the abort reset `initialized`.
    const second = makeMockApi()
    await init(second)

    expect(second.slotsRegister).toHaveBeenCalledTimes(1)
    expect(
      second.toast.mock.calls.some(
        (c) => c[0].message === "usage-total TUI loaded",
      ),
    ).toBe(true)
  })
})
