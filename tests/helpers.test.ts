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

  // Safety guard: a token tracker should never display negative usage.
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

  // Truncation: values below 1M stay in the k band with one truncated decimal.
  it("formats 999999 as '999.9k' (truncated, stays in k band)", () => {
    expect(fmtTokens(999999)).toBe("999.9k")
  })

  it("formats 999950 as '999.9k' (truncated at boundary)", () => {
    expect(fmtTokens(999950)).toBe("999.9k")
  })

  it("formats 999949 as '999.9k' (truncated below boundary)", () => {
    expect(fmtTokens(999949)).toBe("999.9k")
  })

  it("formats millions with an 'M' suffix and one truncated decimal", () => {
    expect(fmtTokens(1_000_000)).toBe("1.0M")
    expect(fmtTokens(1_500_000)).toBe("1.5M")
  })

  // Truncation vs rounding: toFixed(1) rounds up at the .5 boundary,
  // but truncation never overshoots the actual token count.
  it("truncates to one decimal — never rounds up", () => {
    expect(fmtTokens(32_149)).toBe("32.1k")
    expect(fmtTokens(32_150)).toBe("32.1k")
    expect(fmtTokens(32_199)).toBe("32.1k")
    expect(fmtTokens(32_200)).toBe("32.2k")
  })

  it("truncates float token counts by flooring first", () => {
    expect(fmtTokens(1234.9)).toBe("1.2k")
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

  // Clamp negatives: a cost tracker should never display negative costs.
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

  it("returns the input count", () => {
    expect(modelTokens(makeEntry({ tokensInput: 500 }))).toBe(500)
  })

  // Only input tokens count — output, reasoning, and cache are excluded.
  it("returns only input, excluding output/reasoning/cache", () => {
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
    ).toBe(100)
  })

  it("returns 0 when input is 0 regardless of other fields", () => {
    expect(
      modelTokens(
        makeEntry({
          tokensInput: 0,
          tokensOutput: 9_000_000_000,
          tokensReasoning: 1_000_000_000,
          tokensCacheRead: 5_000_000_000,
          tokensCacheWrite: 4_000_000_000,
        }),
      ),
    ).toBe(0)
  })

  it("excludes cacheRead tokens when only cacheRead is set", () => {
    expect(modelTokens(makeEntry({ tokensCacheRead: 750 }))).toBe(0)
  })

  it("excludes cacheWrite tokens when only cacheWrite is set", () => {
    expect(modelTokens(makeEntry({ tokensCacheWrite: 250 }))).toBe(0)
  })

  it("returns 0 when no input is set", () => {
    expect(modelTokens(makeEntry({ tokensOutput: 500 }))).toBe(0)
    expect(modelTokens(makeEntry({ tokensReasoning: 500 }))).toBe(0)
  })

  // A corrupt entry must never push NaN/Infinity into the render — safeNum collapses
  // non-finite values to 0 instead of poisoning the total.
  it("returns 0 when input is NaN (safeNum guard)", () => {
    expect(modelTokens(makeEntry({ tokensInput: NaN }))).toBe(0)
  })

  it("returns 0 when input is Infinity (safeNum guard)", () => {
    expect(modelTokens(makeEntry({ tokensInput: Infinity }))).toBe(0)
  })

  it("ignores NaN in output/reasoning/cache (not part of the sum)", () => {
    expect(
      modelTokens(
        makeEntry({
          tokensInput: 100,
          tokensOutput: NaN,
          tokensReasoning: NaN,
          tokensCacheRead: NaN,
          tokensCacheWrite: NaN,
        }),
      ),
    ).toBe(100)
  })
})
