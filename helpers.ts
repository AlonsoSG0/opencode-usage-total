// Pure helpers extracted from usage-total-tui.tsx for testability.
//
// These functions have no dependency on the opencode plugin API, JSX, or
// solid-js, so they can be unit-tested in isolation under vitest. The
// extraction is mechanical: behavior is identical to the previous inline
// definitions. See tests/helpers.test.ts for the contract.

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
  messageCount: number
}

export type ModelEntryKey = Omit<
  ModelEntry,
  | "cost"
  | "tokensInput"
  | "tokensOutput"
  | "tokensReasoning"
  | "tokensCacheRead"
  | "tokensCacheWrite"
  | "messageCount"
>

export function safeNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

// W1: Round accumulated cost to prevent floating-point drift compounding
// over long sessions (0.1 + 0.2 = 0.30000000000000004 in JS). 6 decimal
// places is well below the 4-place display floor, so no visible precision loss.
export function roundCost(n: number): number {
  return safeNum(Number(n.toFixed(6)))
}

export function fmtTokens(n: number): string {
  // W6: safety clamp — a token tracker should never display negatives.
  // A bad upstream value (drift, double-count, corrupt KV) would otherwise
  // render a "-500" UI glitch and bypass the k/M bands entirely. Clamp to 0.
  if (n < 0) return "0"
  if (!Number.isFinite(n) || n === 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

export function fmtCost(n: number): string {
  // W6: safety clamp — a cost tracker should never display negatives.
  // Without this, a negative value satisfies n < 0.01 and renders as a
  // "$-0.5000" glitch. Clamp to empty (same as the zero/NaN case).
  if (n < 0) return ""
  if (!Number.isFinite(n) || n === 0) return ""
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

// W5: cache tokens (cache.read / cache.write) are included in the total.
// In long-context sessions, cache reads often dominate token usage, so
// excluding them made the sidebar show fewer tokens than actually used.
export function modelTokens(m: ModelEntry): number {
  return (
    m.tokensInput +
    m.tokensOutput +
    m.tokensReasoning +
    m.tokensCacheRead +
    m.tokensCacheWrite
  )
}
