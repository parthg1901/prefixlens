import { describe, expect, test } from "bun:test"
import { costOf, findPrice, loadPricing, normalizeModelId, parsePricing, ratesFor, uncachedRate } from "../src/pricing.ts"
import { TEST_PRICING, usage } from "./helpers.ts"

const table = parsePricing(TEST_PRICING)

describe("pricing", () => {
  test("normalizes harness model ids", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5")
    expect(normalizeModelId("us.anthropic.claude-opus-4-1-20250805-v1:0")).toBe("claude-opus-4-1-20250805-v1:0")
    expect(normalizeModelId("GPT-4.1-mini")).toBe("gpt-4-1-mini")
  })

  test("matches by glob, first entry wins, and respects the provider", () => {
    expect(findPrice(table, "anthropic", "claude-test-9")?.input).toBe(10)
    expect(findPrice(table, "openai", "claude-test-9")).toBeUndefined()
    expect(findPrice(table, "openai", "gpt-test-mini")?.input).toBe(2)
  })

  test("harness provider ids not in the table match on the model alone", () => {
    expect(findPrice(table, "openrouter", "anthropic/claude-test-1")?.input).toBe(10)
  })

  test("tiers apply above their prompt size", () => {
    const tiered = parsePricing({
      models: [{ match: "m", input: 1, output: 2, cache_read: 0.1, tiers: [{ above_prompt_tokens: 1000, input: 5 }] }],
    })
    const entry = findPrice(tiered, "x", "m")!
    expect(ratesFor(entry, 1000).input).toBe(1)
    expect(ratesFor(entry, 1001)).toMatchObject({ input: 5, output: 2 })
  })

  test("prices 5-minute and 1-hour cache writes separately", () => {
    const rates = findPrice(table, "anthropic", "claude-test-1")!
    const cost = costOf({ ...usage(1_000_000, 1_000_000, 1_000_000, 1_000_000), cache_write_1h_tokens: 400_000 }, rates)
    expect(cost.input).toBeCloseTo(10)
    expect(cost.cache_read).toBeCloseTo(1)
    expect(cost.cache_write).toBeCloseTo(0.6 * 12.5 + 0.4 * 20)
    expect(cost.output).toBeCloseTo(50)
    expect(cost.total).toBeCloseTo(10 + 1 + 15.5 + 50)
  })

  test("uncached rate blends input and write prices", () => {
    const rates = findPrice(table, "anthropic", "claude-test-1")!
    expect(uncachedRate(usage(1000, 0, 1000), rates)).toBeCloseTo((10 + 12.5) / 2)
    expect(uncachedRate(usage(0, 10, 0), rates)).toBe(10)
  })

  test("rejects malformed tables", () => {
    expect(() => parsePricing({})).toThrow("models array")
    expect(() => parsePricing({ models: [{ match: "m", input: -1, output: 1, cache_read: 1 }] })).toThrow("input")
    expect(() => parsePricing({ models: [{ match: 3, input: 1, output: 1, cache_read: 1 }] })).toThrow("match")
    expect(() => parsePricing({ unit: "per_token", models: [] })).toThrow("unit")
  })

  test("the bundled table loads and prices current Claude models", async () => {
    const bundled = await loadPricing()
    for (const model of ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5-20250929"])
      expect(findPrice(bundled, "anthropic", model)).toBeDefined()
    expect(findPrice(bundled, "anthropic", "claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cache_read: 0.2 })
    expect(findPrice(bundled, "openai", "gpt-4o-mini-2024-07-18")?.input).toBe(0.15)
  })
})
