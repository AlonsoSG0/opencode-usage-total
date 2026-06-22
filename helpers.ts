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
  const r = Math.round(n)
  if (r < 1_000) return String(r)
  // Band boundary: when the formatted k-value would read "1000.0" (r >= 999950, detected via
  // Math.round(r / 100) >= 10000), bump to the M band to avoid the "1000.0k" display glitch.
  if (r >= 1_000_000 || Math.round(r / 100) >= 10_000) {
    return `${(r / 1_000_000).toFixed(1)}M`
  }
  return `${(r / 1_000).toFixed(1)}k`
}

export function fmtCost(n: number): string {
  // Clamp negatives — a cost tracker should never display negative costs.
  if (n < 0) return ""
  if (!Number.isFinite(n) || n === 0) return ""
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

// Cache tokens (cacheRead/cacheWrite) are stored in ModelEntry but NOT summed here.
// The SDK reports them as a subset of input tokens, not additional tokens — adding them
// would double-count. They're available for breakdown display but excluded from the total.
// The sum is wrapped in safeNum so corrupt entries can never push NaN/Infinity into the render.
export function modelTokens(m: ModelEntry): number {
  return safeNum(
    m.tokensInput +
      m.tokensOutput +
      m.tokensReasoning,
  )
}
