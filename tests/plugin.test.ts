import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MockInstance } from "vitest"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"

// The plugin's JSX is transformed by oxc into imports of the @opentui/solid
// automatic runtime, which in turn pulls in the full @opentui/solid renderer
// (and its terminal/DOM dependencies — "No renderer found" without one). The
// integration tests below exercise lifecycle, event handling, and state —
// never the rendered JSX — so stub the runtime to return null.
//
// oxc runs in development mode under vitest (`development: !isProduction`),
// which routes JSX through `jsx-dev-runtime` (re-exporting `jsxDEV`); the
// production `jsx-runtime` (`jsx`/`jsxs`) is mocked too so the stub holds
// regardless of build mode. This keeps the renderer out of node and lets
// `sidebar_content` run its side effects (loadSession) without crashing.
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

// `tui` ignores options/meta, but its typed signature requires all three args.
const OPTIONS = undefined
const META = {} as unknown as TuiPluginMeta

// ---- Event shapes (only the fields the handler actually reads) ----
interface MockMessageInfo {
  id?: string
  sessionID?: string
  role?: string
  providerID?: string
  modelID?: string
  agent?: string
  mode?: string
  cost?: number
  model?: { providerID?: string; modelID?: string }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}
interface MockMessageUpdatedEvent {
  type?: string
  properties?: { info?: MockMessageInfo }
}

function assistantEvent(
  sessionID: string,
  overrides: MockMessageInfo = {},
): MockMessageUpdatedEvent {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg-1",
        sessionID,
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-3-7-sonnet",
        agent: "primary",
        cost: 0.01,
        tokens: {
          input: 100,
          output: 200,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        ...overrides,
      },
    },
  }
}

// ---- Module-level cleanup tracking ----
// `initialized` and `lastToastTime` live at module scope in the plugin, so we
// must tear down after every test or the init guard locks out the next one.
// `activeCleanup` is updated by the onDispose mock whenever the plugin
// registers; `activeAbort` covers the W3 path where disposal rides on the
// AbortSignal instead of onDispose.
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
}

function makeMockApi(opts: { withOnDispose?: boolean } = {}): MockApi {
  const kvGet = vi.fn<(key: string, fb?: unknown) => unknown>(() => undefined)
  const kvSet = vi.fn<(key: string, value: unknown) => void>()
  const toast = vi.fn<(input: { message: string; variant?: string }) => void>()
  const sessionGet = vi.fn<
    (id: string) => { parentID?: string } | undefined
  >(() => undefined)
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
    state: { session: { get: sessionGet } },
    event: { on: eventOn },
    slots: { register: slotsRegister },
    keymap: { registerLayer: keymapRegisterLayer },
    route: {
      current: { name: "home" },
      register: vi.fn(),
      navigate: vi.fn(),
    },
  } as unknown as TuiPluginApi

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
  }
}

// ---- Captured-resource accessors ----
function getHandler(
  m: MockApi,
): ((e: MockMessageUpdatedEvent) => void) | undefined {
  const calls = m.eventOn.mock.calls
  const last = calls[calls.length - 1]
  if (!last) return undefined
  return last[1] as (e: MockMessageUpdatedEvent) => void
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
  // Fake only the timer APIs + Date the plugin uses, leaving Promise
  // microtasks real so `await init()` resolves normally. Pin the clock so
  // the toast cooldown (Date.now() - lastToastTime > 2000) is deterministic.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"))
  activeCleanup = undefined
  activeAbort = undefined
})

afterEach(() => {
  // Tear down whichever disposal path the plugin used. Calling an
  // already-run cleanup is idempotent; aborting a controller with no
  // listener is a no-op — so this is safe for both the onDispose and W3
  // (AbortSignal) cases and prevents the init guard from leaking across tests.
  try {
    activeCleanup?.()
  } catch {
    /* best-effort teardown */
  }
  try {
    activeAbort?.abort()
  } catch {
    /* best-effort teardown */
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// =====================================================================
// Init guard (C3)
// =====================================================================
describe("init guard", () => {
  it("initializes on first call and registers all resources", async () => {
    const m = makeMockApi()
    await init(m)

    expect(m.slotsRegister).toHaveBeenCalledTimes(1)
    expect(m.eventOn).toHaveBeenCalledTimes(1)
    expect(m.eventOn.mock.calls[0][0]).toBe("message.updated")
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
    expect(second.eventOn).toHaveBeenCalledTimes(1)
    expect(
      second.toast.mock.calls.some(
        (c) => c[0].message === "usage-total TUI loaded",
      ),
    ).toBe(true)
  })
})

// =====================================================================
// Debounce + flush (W2)
// =====================================================================
describe("debounce + flush", () => {
  it("collapses rapid scheduleSave calls into a single KV write", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    // Three rapid events for the same session/model accumulate in state but
    // each scheduleSave resets the debounce timer, so only one KV write fires.
    handler(assistantEvent("s1"))
    handler(assistantEvent("s1"))
    handler(assistantEvent("s1"))

    expect(m.kvSet).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)

    const writes = m.kvSet.mock.calls.filter(([k]) => k === kvKey("s1"))
    expect(writes).toHaveLength(1)
    const models = writes[0][1] as ModelEntry[]
    expect(models).toHaveLength(1)
    // cost accumulated 3× and was rounded; tokens accumulated 3×.
    expect(models[0].cost).toBe(0.03)
    expect(models[0].tokensInput).toBe(300)
    expect(models[0].tokensOutput).toBe(600)
  })

  it("cleanup flushes pending writes before teardown", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(assistantEvent("s1"))
    // Pending save is scheduled but not yet flushed.
    expect(m.kvSet).not.toHaveBeenCalled()

    // Dispose triggers flushPending -> the buffered data reaches KV even
    // though the debounce timer never fired.
    activeCleanup?.()
    expect(modelsSavedFor(m, "s1")).toBeDefined()
    expect(modelsSavedFor(m, "s1")!).toHaveLength(1)
  })
})

// =====================================================================
// Parent-chain attribution (W4 walk)
// =====================================================================
describe("parent-chain attribution", () => {
  it("attributes a depth-1 sub-agent to the root session", async () => {
    const m = makeMockApi()
    // sub's parent is root; root has no parent.
    m.sessionGet.mockImplementation((id) =>
      id === "sub" ? { parentID: "root" } : undefined,
    )
    await init(m)
    const handler = getHandler(m)!

    handler(assistantEvent("sub"))
    vi.advanceTimersByTime(500)

    // Tracked on the event session AND walked up to the root.
    expect(modelsSavedFor(m, "sub")).toBeDefined()
    expect(modelsSavedFor(m, "root")).toBeDefined()
    expect(modelsSavedFor(m, "root")!).toHaveLength(1)
    expect(modelsSavedFor(m, "root")![0].model).toBe("claude-3-7-sonnet")
  })

  it("attributes a depth-2 grandchild to the root session", async () => {
    const m = makeMockApi()
    m.sessionGet.mockImplementation((id) => {
      if (id === "grandchild") return { parentID: "child" }
      if (id === "child") return { parentID: "root" }
      return undefined
    })
    await init(m)
    const handler = getHandler(m)!

    handler(assistantEvent("grandchild"))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "grandchild")).toBeDefined()
    expect(modelsSavedFor(m, "root")).toBeDefined()
    expect(modelsSavedFor(m, "child")).toBeUndefined()
  })

  it("self-referencing parentID does not loop", async () => {
    const m = makeMockApi()
    m.sessionGet.mockImplementation((id) =>
      id === "self" ? { parentID: "self" } : undefined,
    )
    await init(m)
    const handler = getHandler(m)!

    // parentID === sessionID breaks immediately; no root attribution.
    handler(assistantEvent("self"))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "self")).toBeDefined()
    // Only one write total (no extra root write, no infinite loop).
    expect(m.kvSet.mock.calls.filter(([k]) => k === kvKey("self"))).toHaveLength(1)
  })

  it("cyclic parent chain terminates via the visited set", async () => {
    const m = makeMockApi()
    m.sessionGet.mockImplementation((id) => {
      if (id === "a") return { parentID: "b" }
      if (id === "b") return { parentID: "a" }
      return undefined
    })
    await init(m)
    const handler = getHandler(m)!

    // a -> b -> a(cycle). Walk stops at b; b != a so it's attributed to b.
    handler(assistantEvent("a"))
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

    handler(assistantEvent("solo"))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "solo")).toBeDefined()
    expect(m.kvSet.mock.calls).toHaveLength(1)
  })
})

// =====================================================================
// message.updated handler
// =====================================================================
describe("message.updated handler", () => {
  it("tracks a valid assistant event into state", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(assistantEvent("s1"))
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

    handler({ type: "message.updated", properties: {} })
    vi.advanceTimersByTime(500)

    expect(m.kvSet).not.toHaveBeenCalled()
  })

  it("ignores a malformed event with no sessionID", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler({
      type: "message.updated",
      properties: {
        info: { role: "assistant", providerID: "anthropic" },
      },
    })
    vi.advanceTimersByTime(500)

    expect(m.kvSet).not.toHaveBeenCalled()
  })

  it("catches a throwing handler without killing the subscription (W4)", async () => {
    const m = makeMockApi()
    // First session.get throws (simulates a state-layer failure inside the
    // parent-chain walk). Subsequent calls succeed so a later event works.
    m.sessionGet
      .mockImplementationOnce(() => {
        throw new Error("state layer down")
      })
      .mockImplementation(() => undefined)
    await init(m)
    const handler = getHandler(m)!

    // This event's walk throws -> caught -> error toast, but the listener
    // stays alive (no rethrow, no unsubscribe).
    handler(assistantEvent("s1"))
    expect(
      m.toast.mock.calls.some(
        (c) =>
          c[0].message === "usage-total: error processing message" &&
          c[0].variant === "error",
      ),
    ).toBe(true)

    // A second, healthy event is still processed by the same subscription.
    handler(assistantEvent("s1", { modelID: "claude-haiku" }))
    vi.advanceTimersByTime(500)

    expect(modelsSavedFor(m, "s1")).toBeDefined()
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

    handler(assistantEvent("s1"))
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models).toHaveLength(1)
    expect(models[0].model).toBe("claude-3-7-sonnet")
  })

  it("accumulates cost and tokens for a duplicate model", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(assistantEvent("s1"))
    handler(assistantEvent("s1"))
    vi.advanceTimersByTime(500)

    const models = modelsSavedFor(m, "s1")!
    expect(models).toHaveLength(1)
    // roundCost(0.01 + 0.01) === 0.02; tokens summed linearly.
    expect(models[0].cost).toBe(0.02)
    expect(models[0].tokensInput).toBe(200)
    expect(models[0].tokensOutput).toBe(400)
  })

  it("sanitizes NaN/Infinity cost and tokens to 0", async () => {
    const m = makeMockApi()
    await init(m)
    const handler = getHandler(m)!

    handler(
      assistantEvent("s1", {
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
// loadSession KV validation (B2)
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
    handler(assistantEvent("s1", { providerID: "anthropic" }))
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
    // First entry fine, second has a non-string provider -> whole array
    // rejected (B2 validates every entry, not just [0]).
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
// onDispose fallback via AbortSignal (W3)
// =====================================================================
describe("onDispose fallback (W3)", () => {
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
