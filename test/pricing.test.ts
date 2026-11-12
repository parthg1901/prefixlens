import { describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { costOf, findPrice, loadPricing, normalizeModelId, parsePricing, providerFacts, ratesFor, uncachedRate, type PriceEntry, type PricingTable } from "../src/pricing.ts"
import { normalizeUsage, promptTokens } from "../src/usage.ts"
import { TEST_PRICING, usage, usageRecord } from "./helpers.ts"

const table = parsePricing(TEST_PRICING)
const bundled = await loadPricing()
const bundledJson = await Bun.file(new URL("../pricing.json", import.meta.url)).json()

/** The bundled price for a model on a given day, failing the test when there is none. */
function price(provider: string, model: string, ts = "2026-11-12T12:00:00Z", params?: Record<string, unknown>): PriceEntry {
  const entry = findPrice(bundled, provider, model, { ts, ...(params ? { params } : {}) })
  if (!entry) throw new Error(`no bundled price for ${provider} ${model} on ${ts}`)
  return entry
}

describe("pricing", () => {
  test("normalizes harness, router and cloud model ids", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5")
    expect(normalizeModelId("us.anthropic.claude-opus-4-1-20250805-v1:0")).toBe("claude-opus-4-1-20250805")
    expect(normalizeModelId("global.anthropic.claude-fable-5-2")).toBe("claude-fable-5-2")
    expect(normalizeModelId("claude-haiku-4-5@20251001")).toBe("claude-haiku-4-5-20251001")
    expect(normalizeModelId("openai.gpt-6-luna")).toBe("gpt-6-luna")
    expect(normalizeModelId("openrouter/openai/GPT-6.1-Sol")).toBe("gpt-6-1-sol")
    expect(normalizeModelId("models/gemini-2.5-pro")).toBe("gemini-2-5-pro")
  })

  test("glob patterns in a hand-written table match, first entry wins, and respect the provider", () => {
    expect(findPrice(table, "anthropic", "claude-test-9")?.input).toBe(10)
    expect(findPrice(table, "openai", "claude-test-9")).toBeUndefined()
    expect(findPrice(table, "openai", "gpt-test-mini")?.input).toBe(2)
  })

  test("harness provider ids not in the table match on the model alone", () => {
    expect(findPrice(table, "openrouter", "anthropic/claude-test-1")?.input).toBe(10)
    expect(findPrice(bundled, "openrouter", "openai/gpt-6-luna")?.input).toBe(0.1)
  })

  test("an exact name beats a glob listed before it", () => {
    const mixed = parsePricing({
      models: [
        { match: "m*", input: 9, output: 9, cache_read: 0.9 },
        { names: ["m-1"], input: 1, output: 1, cache_read: 0.1 },
      ],
    })
    expect(findPrice(mixed, "x", "m-1")?.input).toBe(1)
    expect(findPrice(mixed, "x", "m-2")?.input).toBe(9)
  })

  test("tiers apply above their prompt size", () => {
    const tiered = parsePricing({
      models: [{ names: ["m"], input: 1, output: 2, cache_read: 0.1, tiers: [{ above_prompt_tokens: 1000, input: 5 }] }],
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
    const rates = { input: 1, output: 1, cache_read: 1 }
    expect(() => parsePricing({})).toThrow("models array")
    expect(() => parsePricing({ models: [{ match: "m", input: -1, output: 1, cache_read: 1 }] })).toThrow("input")
    expect(() => parsePricing({ models: [{ match: 3, ...rates }] })).toThrow("match")
    expect(() => parsePricing({ models: [rates] })).toThrow("needs names")
    expect(() => parsePricing({ models: [{ names: [], ...rates }] })).toThrow("names")
    expect(() => parsePricing({ models: [{ names: ["m"], until: "30 Nov 2026", ...rates }] })).toThrow("until")
    expect(() => parsePricing({ models: [{ names: ["m"], from: "2026-12-01", until: "2026-11-30", ...rates }] })).toThrow("after")
    expect(() => parsePricing({ models: [{ names: ["m"], ...rates, tiers: [{ input: 2 }] }] })).toThrow("above_prompt_tokens")
    expect(() => parsePricing({ unit: "per_token", models: [] })).toThrow("unit")
    expect(() => parsePricing({ as_of: "yesterday", models: [] })).toThrow("as_of")
  })

  test("rejects a model listed twice for the same provider, parameters and days", () => {
    const rates = { input: 1, output: 1, cache_read: 0.1 }
    expect(() => parsePricing({ models: [{ names: ["gpt-x"], ...rates }, { names: ["GPT.x"], ...rates }] })).toThrow("gpt-x is listed in models[0] and models[1]")
    expect(() =>
      parsePricing({ models: [{ names: ["m"], until: "2026-11-30", ...rates }, { names: ["m"], from: "2026-11-30", ...rates }] }),
    ).toThrow("listed in")
    // Distinct days, distinct parameters or distinct providers are not duplicates.
    expect(() =>
      parsePricing({
        models: [
          { names: ["m"], until: "2026-11-30", ...rates },
          { names: ["m"], from: "2026-12-01", ...rates },
          { names: ["m"], when_params: { speed: "fast" }, ...rates },
          { provider: "a", names: ["n"], ...rates },
          { provider: "b", names: ["n"], ...rates },
        ],
      }),
    ).not.toThrow()
  })
})

describe("the bundled pricing table", () => {
  test("every entry has exact names, the required prices and sane numbers", () => {
    const entries = bundled.models
    expect(entries.length).toBeGreaterThan(50)
    for (const entry of entries) {
      const at = JSON.stringify(entry.names)
      expect(["anthropic", "openai", "gemini"], at).toContain(entry.provider!)
      expect(entry.match, `${at}: no globs in the bundled table`).toBeUndefined()
      expect(entry.names!.length, at).toBeGreaterThan(0)
      for (const rates of [entry, ...(entry.tiers ?? [])]) {
        const full = { ...entry, ...rates }
        for (const field of ["input", "output", "cache_read"] as const) expect(full[field], `${at} ${field}`).toBeGreaterThan(0)
        // No provider charges more for a cached token than an uncached one; the pro models charge the same.
        expect(full.cache_read, `${at} cache_read`).toBeLessThanOrEqual(full.input)
        if (full.cache_write !== undefined) expect(full.cache_write, `${at} cache_write`).toBeGreaterThanOrEqual(full.input)
        if (full.cache_write_1h !== undefined) expect(full.cache_write_1h, `${at} cache_write_1h`).toBeGreaterThan(full.cache_write!)
        if (full.cache_write_12h !== undefined) expect(full.cache_write_12h, `${at} cache_write_12h`).toBeGreaterThan(full.cache_write!)
      }
      for (const tier of entry.tiers ?? []) expect(tier.above_prompt_tokens, at).toBeGreaterThan(0)
      if (entry.provider === "anthropic") expect(entry.cache_write_1h, `${at}: Anthropic has two write prices`).toBeDefined()
      if (entry.provider === "gemini") expect(entry.cache_write, `${at}: Gemini reports no writes`).toBeUndefined()
    }
  })

  test("says where each provider's prices came from and when they were checked", () => {
    for (const provider of ["anthropic", "openai", "gemini"]) {
      const source = bundledJson.sources[provider]
      expect(source.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(source.checked <= bundled.as_of!).toBe(true)
      expect(source.urls.length).toBeGreaterThan(0)
      expect(source.urls[0]).toMatch(/^https:\/\/(platform\.claude\.com|developers\.openai\.com|ai\.google\.dev)\//)
    }
  })

  test("prices the current models of each provider", () => {
    for (const model of ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5"])
      expect(findPrice(bundled, "anthropic", model), model).toBeDefined()
    for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-2026-03-05"])
      expect(findPrice(bundled, "openai", model, { ts: "2026-11-12T00:00:00Z" }), model).toBeDefined()
    for (const model of ["gemini-4-carbon", "gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash-lite"])
      expect(findPrice(bundled, "gemini", model, { ts: "2026-11-12T00:00:00Z" }), model).toBeDefined()
    expect(price("anthropic", "claude-opus-5-5")).toMatchObject({ input: 4, cache_read: 0.2, cache_write: 5, cache_write_1h: 8, output: 20 })
    expect(price("openai", "gpt-6-luna")).toMatchObject({ input: 0.1, cache_read: 0.01, cache_write: 0.125, output: 0.5 })
  })

  test("matches only exact names and documented id forms, never a neighbour's price", () => {
    const none = (provider: string, model: string) => expect(findPrice(bundled, provider, model, { ts: "2026-11-12T00:00:00Z" }), model).toBeUndefined()
    none("openai", "gpt-6") // a family name is not a model
    none("openai", "gpt-6-luna-high") // effort suffixes are not stripped
    none("openai", "gpt-6-luna-fast") // OpenAI documents no -fast ids
    none("openai", "gpt-4o-2024-05-13") // shut down, and priced differently from gpt-4o
    none("anthropic", "claude-opus-5-5-high")
    none("anthropic", "claude-3-5-sonnet-20241022") // retired, no longer listed
    none("anthropic", "gpt-6-luna") // provider mismatch
    none("gemini", "gemini-flash-latest") // hot-swapped alias
    expect(price("anthropic", "anthropic.claude-opus-5-5").input).toBe(4)
    expect(price("anthropic", "claude-opus-4-5@20251101").input).toBe(5)
    expect(price("openai", "openai/gpt-5.6-terra").input).toBe(2)
  })

  test("Anthropic fast mode is priced from the request's speed parameter or a -fast id", () => {
    expect(price("anthropic", "claude-opus-5-5", undefined, { speed: "fast" })).toMatchObject({ input: 8, cache_read: 0.4, cache_write: 10, cache_write_1h: 16, output: 40 })
    expect(price("anthropic", "claude-opus-5-5", undefined, { speed: "standard" }).input).toBe(4)
    expect(price("anthropic", "claude-opus-5-5-fast").input).toBe(8)
    expect(price("anthropic", "claude-fable-5-2", undefined, { speed: "fast" })).toMatchObject({ input: 16, cache_read: 0.4, output: 80 })
    // Opus 4.8 fast mode is removed after 2026-11-30; its standard price stays.
    expect(price("anthropic", "claude-opus-4-8", "2026-12-01T00:00:00Z", { speed: "fast" }).input).toBe(5)
    // Sonnet has no fast mode, so the parameter changes nothing.
    expect(price("anthropic", "claude-sonnet-5-5", undefined, { speed: "fast" }).input).toBe(2)
  })

  test("prices that change on a set day follow the call's date", () => {
    expect(price("gemini", "gemini-4-carbon", "2026-11-30T23:59:59Z").input).toBe(2)
    expect(price("gemini", "gemini-4-carbon", "2026-12-01T00:00:00Z").input).toBe(4)
    expect(price("gemini", "gemini-3.8-flash", "2027-01-01T00:00:00Z").output).toBe(7.5)
    // gemini-2.5-pro is billed at gemini-3.8-flash rates from 2026-12-01.
    expect(price("gemini", "gemini-2.5-pro", "2026-11-30T12:00:00Z").input).toBe(1.25)
    expect(price("gemini", "gemini-2.5-pro", "2026-12-15T12:00:00Z").input).toBe(0.75)
    // GPT-5.6 Sol's promotional price ends 2026-11-30 and the next price is not published.
    expect(findPrice(bundled, "openai", "gpt-5.6-sol", { ts: "2026-12-03T00:00:00Z" })).toBeUndefined()
    // Without a date, a dated price cannot be chosen.
    expect(findPrice(bundled, "gemini", "gemini-4-carbon")).toBeUndefined()
  })

  test("per-model cache facts override the provider's", () => {
    expect(providerFacts(bundled, "openai", price("openai", "gpt-6-luna"))).toEqual({ cache_ttl_seconds: 1800, min_cacheable_tokens: 1024 })
    expect(providerFacts(bundled, "openai", price("openai", "gpt-4.1"))).toEqual({ cache_ttl_seconds: 300, min_cacheable_tokens: 1024 })
    expect(providerFacts(bundled, "anthropic", price("anthropic", "claude-haiku-4-5")).min_cacheable_tokens).toBe(4096)
    expect(providerFacts(bundled, "gemini", price("gemini", "gemini-2.5-flash")).min_cacheable_tokens).toBe(2048)
  })
})

describe("cost arithmetic per provider", () => {
  test("Anthropic: 5-minute and 1-hour writes at their own prices", () => {
    // 1,000 uncached, 50,000 read, 10,000 written (4,000 of them with a 1-hour TTL), 2,000 out on Opus 5.5.
    const used = { ...usage(1000, 50_000, 10_000, 2000), cache_write_1h_tokens: 4000 }
    const cost = costOf(used, ratesFor(price("anthropic", "claude-opus-5-5"), promptTokens(used)))
    expect(cost.input).toBeCloseTo((1000 * 4) / 1e6, 12)
    expect(cost.cache_read).toBeCloseTo((50_000 * 0.2) / 1e6, 12)
    expect(cost.cache_write).toBeCloseTo((6000 * 5 + 4000 * 8) / 1e6, 12)
    expect(cost.output).toBeCloseTo((2000 * 20) / 1e6, 12)
    expect(cost.total).toBeCloseTo(0.116, 12)
    // The same call in fast mode costs twice as much.
    const fast = costOf(used, ratesFor(price("anthropic", "claude-opus-5-5", undefined, { speed: "fast" }), promptTokens(used)))
    expect(fast.total).toBeCloseTo(0.232, 12)
  })

  test("Anthropic: Haiku 5.5 prices the whole request higher above 100,000 prompt tokens", () => {
    const entry = price("anthropic", "claude-haiku-5-5")
    const long = usage(10_000, 120_000, 20_000, 1000) // prompt 150,000
    expect(costOf(long, ratesFor(entry, promptTokens(long))).total).toBeCloseTo((10_000 * 0.5 + 120_000 * 0.05 + 20_000 * 0.625 + 1000 * 2.5) / 1e6, 12)
    const atLimit = usage(10_000, 70_000, 20_000, 1000) // prompt exactly 100,000: base prices
    expect(costOf(atLimit, ratesFor(entry, promptTokens(atLimit))).total).toBeCloseTo((10_000 * 0.1 + 70_000 * 0.01 + 20_000 * 0.125 + 1000 * 0.5) / 1e6, 12)
  })

  test("OpenAI GPT-5.6 and later: reported cache writes are priced as writes", () => {
    // The worked example of OpenAI's caching guide: 12,000 input, 4,000 cached, 7,000 written.
    const used = normalizeUsage("openai", { input_tokens: 12_000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 }, output_tokens: 500 })
    expect(used).toMatchObject({ input_tokens: 1000, cache_read_tokens: 4000, cache_write_tokens: 7000, output_tokens: 500 })
    const cost = costOf(used, ratesFor(price("openai", "gpt-6-luna"), promptTokens(used)))
    expect(cost.total).toBeCloseTo((1000 * 0.1 + 4000 * 0.01 + 7000 * 0.125 + 500 * 0.5) / 1e6, 12)
  })

  test("OpenAI: earlier models report no writes, and long prompts are priced higher above 272,000 tokens", () => {
    const old = normalizeUsage("openai", { prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 2048 }, completion_tokens: 10 })
    expect(old).toMatchObject({ input_tokens: 952, cache_read_tokens: 2048, cache_write_tokens: null })
    const long = usage(50_000, 250_000, 0, 1000) // prompt 300,000
    expect(costOf(long, ratesFor(price("openai", "gpt-6.1-sol"), promptTokens(long))).total).toBeCloseTo((50_000 * 4 + 250_000 * 0.2 + 1000 * 15) / 1e6, 12)
    const short = usage(22_000, 250_000, 0, 1000) // prompt 272,000: short-context prices
    expect(costOf(short, ratesFor(price("openai", "gpt-6.1-sol"), promptTokens(short))).total).toBeCloseTo((22_000 * 2 + 250_000 * 0.1 + 1000 * 10) / 1e6, 12)
  })

  test("Gemini: cached tokens at the caching price, and Pro's long-prompt tier above 200,000", () => {
    const used = normalizeUsage("gemini", { promptTokenCount: 10_000, cachedContentTokenCount: 8000, candidatesTokenCount: 300, thoughtsTokenCount: 200 })
    expect(costOf(used, ratesFor(price("gemini", "gemini-3.8-flash"), promptTokens(used))).total).toBeCloseTo((2000 * 0.75 + 8000 * 0.075 + 500 * 3.75) / 1e6, 12)
    const long = usage(1000, 210_000, null, 100)
    expect(costOf(long, ratesFor(price("gemini", "gemini-3.1-pro-preview"), promptTokens(long))).total).toBeCloseTo((1000 * 4 + 210_000 * 0.4 + 100 * 18) / 1e6, 12)
  })
})

describe("report notes about prices", () => {
  const priced = (pricing: PricingTable, now: Date) =>
    analyze([usageRecord("claude-opus-5-5", usage(10, 0, 2000)), usageRecord("claude-opus-5-5", usage(10, 2000, 100))], { pricing, now }).summary

  test("costs are labelled as list prices, never as what was paid", () => {
    const summary = priced(bundled, new Date("2026-11-20T00:00:00Z"))
    expect(summary.notes).toContain(
      "Costs are at API list prices: what these calls would cost billed per token, not what was paid. Calls on a subscription (a Claude plan, ChatGPT sign-in, Codex) are not billed per token, and discounts, batch and priority tiers are not applied.",
    )
    const unpriced = analyze([usageRecord("claude-unknown", usage(10, 0, 2000))], { pricing: bundled }).summary
    expect(unpriced.notes.some((note) => note.includes("list prices"))).toBe(false)
  })

  test("says how old the table is once it is older than its threshold", () => {
    expect(priced(bundled, new Date("2027-01-11T00:00:00Z")).notes.some((note) => note.includes("days old"))).toBe(false) // 60 days
    expect(priced(bundled, new Date("2027-01-12T00:00:00Z")).notes).toContain(
      "The pricing table is 61 days old (as of 2026-11-12) and prices change: update it or pass a current one with --pricing (see Pricing in the README).",
    )
    expect(priced(parsePricing({ ...bundledJson, stale_after_days: 5 }), new Date("2026-11-20T00:00:00Z")).notes.some((note) => note.includes("8 days old"))).toBe(true)
    const { as_of: _, ...undated } = bundledJson
    expect(priced(parsePricing(undated), new Date()).notes).toContain("The pricing table has no as_of date, so how current its prices are is unknown.")
  })

  test("a model priced only on other days is named with the days it is priced", () => {
    const summary = analyze([usageRecord("gpt-5.6-sol", usage(10, 0, null), { provider: "openai", ts: "2026-12-03T10:00:00Z" })], { pricing: bundled }).summary
    expect(summary.unpriced_models).toEqual(["gpt-5.6-sol"])
    expect(summary.notes).toContain("No price for gpt-5.6-sol on 2026-12-03 (priced until 2026-11-30): add it to the pricing table to get costs.")
  })
})

describe("exclusions and families in the table", () => {
  const base = { version: 1, currency: "USD", unit: "per_million_tokens", models: [{ provider: "openai", names: ["gpt-zeta-1"], input: 1, cache_read: 0.1, output: 2 }] }

  test("exclude and families are checked at the boundary", () => {
    expect(() => parsePricing({ ...base, exclude: [{ names: ["gpt-zeta-latest"] }] })).toThrow("exclude[0] needs names (model ids) and a reason")
    expect(() => parsePricing({ ...base, exclude: [{ provider: "openai", names: ["gpt-zeta-1"], reason: "alias" }] })).toThrow("gpt-zeta-1 is both priced in models and listed in exclude")
    expect(() => parsePricing({ ...base, families: [{ provider: "openai", prefixes: [] }] })).toThrow("families[0] needs a provider and prefixes")
    expect(() => parsePricing({ ...base, families: [{ provider: "openai", prefixes: ["gpt-zeta"], cache_ttl_seconds: 0 }] })).toThrow("families[0].cache_ttl_seconds must be a positive number")
  })

  test("an entry's facts beat its family's, which beat the provider's; the longest prefix wins", () => {
    const table = parsePricing({
      ...base,
      providers: { openai: { cache_ttl_seconds: 300 } },
      families: [
        { provider: "openai", prefixes: ["gpt-zeta"], cache_ttl_seconds: 1800 },
        { provider: "openai", prefixes: ["gpt-zeta-mini"], cache_ttl_seconds: 600 },
      ],
    })
    expect(providerFacts(table, "openai", undefined, "gpt-zeta-2").cache_ttl_seconds).toBe(1800)
    expect(providerFacts(table, "openai", undefined, "gpt-zeta-mini-2").cache_ttl_seconds).toBe(600)
    expect(providerFacts(table, "openai", { ...table.models[0]!, cache_ttl_seconds: 60 }, "gpt-zeta-1").cache_ttl_seconds).toBe(60)
    expect(providerFacts(table, "anthropic", undefined, "gpt-zeta-2").cache_ttl_seconds).toBe(300)
  })

  test("a report names an excluded model's reason instead of guessing a price", () => {
    const table = parsePricing({ ...base, exclude: [{ provider: "openai", names: ["gpt-zeta-latest"], reason: "an alias that moves" }] })
    const analysis = analyze([usageRecord("gpt-zeta-latest", usage(100, 2000, null), { provider: "openai" })], { pricing: table })
    expect(analysis.summary.notes.join("\n")).toContain("No price for gpt-zeta-latest (left unpriced on purpose by the pricing table: an alias that moves)")
  })
})
