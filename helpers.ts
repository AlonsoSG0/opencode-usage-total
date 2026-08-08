// Pure helpers extracted from usage-total-tui.tsx for testability.
// These have no plugin API, JSX, or solid-js dependency. See tests/helpers.test.ts.

export interface ModelEntry {
  provider: string
  model: string
  agent: string
  cost: number
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  tokensCacheWrite: number
}

export type ModelEntryKey = Omit<
  ModelEntry,
  | "cost"
  | "tokensInput"
  | "tokensOutput"
  | "tokensReasoning"
  | "tokensCacheRead"
  | "tokensCacheWrite"
>

export function safeNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

// Round to 6 decimal places to prevent floating-point drift compounding over long sessions
// (0.1 + 0.2 = 0.30000000000000004 in JS). Six places is well below the 4-place display floor.
export function roundCost(n: number): number {
  return safeNum(Number(n.toFixed(6)))
}

export function fmtTokens(n: number): string {
  // Clamp negatives and non-finite values — a token tracker should never display negative usage.
  if (!Number.isFinite(n) || n < 0) return "0"
  const r = Math.floor(n)
  if (r < 1_000) return String(r)
  if (r >= 1_000_000) {
    return `${(Math.floor(r / 100_000) / 10).toFixed(1)}M`
  }
  return `${(Math.floor(r / 100) / 10).toFixed(1)}k`
}

export function fmtCost(n: number): string {
  // Clamp negatives — a cost tracker should never display negative costs.
  if (n < 0) return ""
  if (!Number.isFinite(n) || n === 0) return ""
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

// Context size = input tokens only. Output, reasoning, and cache tokens are excluded
// because they're generation artifacts, not part of the context window.
// Wrapped in safeNum so corrupt entries can never push NaN/Infinity into the render.
export function modelTokens(m: ModelEntry): number {
  return safeNum(m.tokensInput)
}

// Matches the official opencode app's `lastAssistantWithTokens`:
// iterates messages newest-first, returns the most recent assistant turn that
// has any token usage reported. The plugin displays this message's `tokens`
// as the "context size" because that's what the official UI surfaces — NOT
// the session's accumulated `tokens`, which can include multiple turns
// and tool-call rounds and doesn't match what the user sees in opencode.
//
// Caller passes `ReadonlyArray<{ role: string; tokens?: { ... } | null }>`
// to stay decoupled from the SDK Message type.
export interface TokenReport {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}
export interface MessageLike {
  role: string
  tokens?: TokenReport | null
}
export function tokenTotal(m: MessageLike): number {
  const t = m.tokens
  if (!t) return 0
  return safeNum(t.input) + safeNum(t.output) + safeNum(t.reasoning) + safeNum(t.cache?.read) + safeNum(t.cache?.write)
}
export function lastAssistantWithTokens<T extends MessageLike>(messages: ReadonlyArray<T>): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
  return undefined
}

// Sums the cost field of every assistant message in a session. Mirrors the
// official app's `totalCost` in session-context-metrics.ts, which is per-message
// (assistantMessage.cost is already accumulated per message by the processor).
// Using `session.cost` directly would be wrong because the in-memory state
// exposed by `api.state.session.get()` lags behind the DB on session.updated
// gaps, while the messages array is updated incrementally.
export function sumAssistantCost(messages: ReadonlyArray<MessageLike & { cost?: number }>): number {
  return messages.reduce((sum, m) => (m.role === "assistant" ? sum + safeNum(m.cost) : sum), 0)
}
