import { describe, expect, it } from "vitest"
import {
  fmtCost,
  fmtTokens,
  modelTokens,
  roundCost,
  safeNum,
  type ModelEntry,
} from "../helpers"

// Build a valid ModelEntry with sensible defaults so each test only spells
// out the fields it cares about. Keeps the modelTokens assertions readable.
function makeEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    provider: "test-provider",
    model: "test-model",
    agent: "primary",
    cost: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    ...overrides,
  }
}

describe("safeNum", () => {
  it("passes finite numbers through unchanged", () => {
    expect(safeNum(5)).toBe(5)
    expect(safeNum(3.14)).toBe(3.14)
  })

  it("converts NaN to 0", () => {
    expect(safeNum(NaN)).toBe(0)
  })

  it("converts Infinity and -Infinity to 0", () => {
    expect(safeNum(Infinity)).toBe(0)
    expect(safeNum(-Infinity)).toBe(0)
  })

  it("converts numeric strings to numbers", () => {
    expect(safeNum("5")).toBe(5)
    expect(safeNum("3.14")).toBe(3.14)
  })

  it("converts non-numeric strings to 0", () => {
    expect(safeNum("abc")).toBe(0)
  })

  it("converts undefined to 0", () => {
    expect(safeNum(undefined)).toBe(0)
  })

  it("converts null to 0", () => {
    expect(safeNum(null)).toBe(0)
  })

  it("converts objects to 0", () => {
    expect(safeNum({})).toBe(0)
    expect(safeNum({ a: 1 })).toBe(0)
  })

  it("converts booleans via Number()", () => {
    expect(safeNum(true)).toBe(1)
    expect(safeNum(false)).toBe(0)
  })
})

describe("roundCost", () => {
  it("eliminates float drift from 0.1 + 0.2", () => {
    // The raw sum drifts to 0.30000000000000004; roundCost must collapse it
    // back to exactly 0.3. The guard below proves the drift still exists in
    // raw arithmetic so this test is meaningful.
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(roundCost(0.1 + 0.2)).toBe(0.3)
  })

  it("rounds to 6 decimal places", () => {
    expect(roundCost(1.123456789)).toBe(1.123457)
  })

  it("passes 0 through", () => {
    expect(roundCost(0)).toBe(0)
  })

  it("converts NaN to 0", () => {
    expect(roundCost(NaN)).toBe(0)
  })

  it("preserves negative values", () => {
    expect(roundCost(-0.1)).toBe(-0.1)
  })
})

describe("fmtTokens", () => {
  it("formats 0 as '0'", () => {
    expect(fmtTokens(0)).toBe("0")
  })

  it("formats NaN as '0'", () => {
    expect(fmtTokens(NaN)).toBe("0")
  })

  it("formats Infinity as '0'", () => {
    expect(fmtTokens(Infinity)).toBe("0")
  })

  // W6: negatives are clamped to "0" — a token tracker should never
  // display negative usage. This is a safety guard against corrupt
  // upstream values, not a formatting preference.
  it("clamps negative numbers to '0'", () => {
    expect(fmtTokens(-500)).toBe("0")
    expect(fmtTokens(-1000)).toBe("0")
    expect(fmtTokens(-1_500_000)).toBe("0")
  })

  it("formats single units", () => {
    expect(fmtTokens(1)).toBe("1")
  })

  it("rounds sub-thousand values with Math.round", () => {
    expect(fmtTokens(999)).toBe("999")
  })

  it("formats thousands with a 'k' suffix and one decimal", () => {
    expect(fmtTokens(1000)).toBe("1.0k")
  })

  // S2 (audit fix): 999999 previously rendered as "1000.0k" because the k
  // band divides by 1000 and formats one decimal, so a value just below 1M
  // rounded up to a 4-digit "1000.0k" display. The band now bumps to M once
  // the formatted k-value would read "1000.0" (r >= 999950).
  it("formats 999999 as '1.0M' (S2 boundary fix)", () => {
    expect(fmtTokens(999999)).toBe("1.0M")
  })

  // S2: exact lower boundary — the first value that would have rendered as
  // "1000.0k" under the old logic now bumps to "1.0M".
  it("formats 999950 as '1.0M' (S2 boundary lower edge)", () => {
    expect(fmtTokens(999950)).toBe("1.0M")
  })

  // S2: just below the boundary stays in the k band with a clean display.
  it("formats 999949 as '999.9k' (S2 just below boundary)", () => {
    expect(fmtTokens(999949)).toBe("999.9k")
  })

  it("formats millions with an 'M' suffix and one decimal", () => {
    expect(fmtTokens(1_000_000)).toBe("1.0M")
    expect(fmtTokens(1_500_000)).toBe("1.5M")
  })
})

describe("fmtCost", () => {
  it("formats 0 as an empty string", () => {
    expect(fmtCost(0)).toBe("")
  })

  it("formats NaN as an empty string", () => {
    expect(fmtCost(NaN)).toBe("")
  })

  it("formats Infinity as an empty string", () => {
    expect(fmtCost(Infinity)).toBe("")
  })

  // W6: negatives are clamped to an empty string — a cost tracker
  // should never display negative costs. This is a safety guard against
  // corrupt upstream values.
  it("clamps negative costs to an empty string", () => {
    expect(fmtCost(-0.5)).toBe("")
    expect(fmtCost(-10)).toBe("")
  })

  it("formats sub-cent costs with 4 decimals", () => {
    expect(fmtCost(0.001)).toBe("$0.0010")
  })

  it("formats cent-and-above costs with 2 decimals", () => {
    expect(fmtCost(0.01)).toBe("$0.01")
    expect(fmtCost(0.5)).toBe("$0.50")
    expect(fmtCost(10)).toBe("$10.00")
    expect(fmtCost(1234.5)).toBe("$1234.50")
  })
})

describe("modelTokens", () => {
  it("returns 0 when all token fields are 0", () => {
    expect(modelTokens(makeEntry())).toBe(0)
  })

  it("returns the input count when only input is set", () => {
    expect(modelTokens(makeEntry({ tokensInput: 500 }))).toBe(500)
  })

  it("sums input, output, reasoning, and cache tokens", () => {
    expect(
      modelTokens(
        makeEntry({
          tokensInput: 100,
          tokensOutput: 200,
          tokensReasoning: 300,
          tokensCacheRead: 400,
          tokensCacheWrite: 500,
        }),
      ),
    ).toBe(1500)
  })

  it("sums large numbers without overflow in the JS number range", () => {
    expect(
      modelTokens(
        makeEntry({
          tokensInput: 1_000_000_000,
          tokensOutput: 9_000_000_000,
          tokensReasoning: 1_000_000_000,
          tokensCacheRead: 5_000_000_000,
          tokensCacheWrite: 4_000_000_000,
        }),
      ),
    ).toBe(20_000_000_000)
  })

  // W5: cache tokens must be part of the total. In long-context sessions
  // cache reads can dominate, so omitting them made the sidebar under-report.
  it("includes cacheRead tokens when only cacheRead is set", () => {
    expect(modelTokens(makeEntry({ tokensCacheRead: 750 }))).toBe(750)
  })

  it("includes cacheWrite tokens when only cacheWrite is set", () => {
    expect(modelTokens(makeEntry({ tokensCacheWrite: 250 }))).toBe(250)
  })

  it("sums cacheRead and cacheWrite together", () => {
    expect(
      modelTokens(
        makeEntry({
          tokensCacheRead: 750,
          tokensCacheWrite: 250,
        }),
      ),
    ).toBe(1000)
  })

  it("does not alter the sum when cache tokens are all zero", () => {
    expect(
      modelTokens(
        makeEntry({
          tokensInput: 100,
          tokensOutput: 200,
          tokensReasoning: 300,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
        }),
      ),
    ).toBe(600)
  })

  // C4: modelTokens is called directly in the sidebar render, so a corrupt
  // entry must never push NaN/Infinity into the total reduce or fmtTokens.
  // The sum is wrapped in safeNum so any non-finite field collapses to 0
  // instead of poisoning the whole total.
  it("returns 0 when any token field is NaN (C4 safeNum guard)", () => {
    expect(modelTokens(makeEntry({ tokensInput: NaN }))).toBe(0)
    expect(modelTokens(makeEntry({ tokensOutput: NaN }))).toBe(0)
    expect(modelTokens(makeEntry({ tokensReasoning: NaN }))).toBe(0)
    expect(modelTokens(makeEntry({ tokensCacheRead: NaN }))).toBe(0)
    expect(modelTokens(makeEntry({ tokensCacheWrite: NaN }))).toBe(0)
  })

  it("returns 0 when any token field is Infinity (C4 safeNum guard)", () => {
    expect(modelTokens(makeEntry({ tokensInput: Infinity }))).toBe(0)
    expect(modelTokens(makeEntry({ tokensOutput: -Infinity }))).toBe(0)
  })

  it("zeroes the whole total when any field is NaN (C4 whole-sum wrap)", () => {
    // The C4 fix wraps the entire sum in safeNum (the simplest guard), so a
    // single NaN field makes the sum NaN and the total collapses to 0 rather
    // than propagating NaN into the render. In practice state never holds NaN
    // (upsertModel sanitizes, loadSession validates), so this is a
    // defense-in-depth render guard — "0" is the safe fallback, not "NaN".
    expect(
      modelTokens(
        makeEntry({
          tokensInput: 100,
          tokensOutput: NaN,
          tokensReasoning: 300,
        }),
      ),
    ).toBe(0)
  })
})
