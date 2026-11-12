// A reported cache-write figure, an absent one and a zero mean different things
// per provider. A zero from a provider that caches implicitly must never make
// the uncached part of a prompt look accounted for: the ChatGPT sign-in
// backend reports zero writes on every call while caching the prompt, and a
// real partial miss once read as a hit because of it.

import { describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { buildRecord, readResponse } from "../src/record/exchange.ts"
import type { TraceRecord } from "../src/trace.ts"
import { normalizeUsage } from "../src/usage.ts"
import { TEST_PRICING } from "./helpers.ts"

const pricing = parsePricing(TEST_PRICING)
const input = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })
const first = { model: "gpt-test-1", stream: true, instructions: "Synthetic.", input: [input("one")] }
const second = { ...first, input: [input("one"), input("two")] }

// The Responses usage of a call: `writes` undefined leaves the field out.
const responses = (total: number, cached: number, writes?: number) => ({
  type: "response.completed",
  response: { id: `resp_${total}_${cached}`, usage: { input_tokens: total, input_tokens_details: { cached_tokens: cached, ...(writes === undefined ? {} : { cache_write_tokens: writes }) }, output_tokens: 5 } },
})

function record(body: Record<string, unknown>, response: unknown, at: number): TraceRecord {
  const built = buildRecord({ api: "openai-responses", body, response: readResponse("openai-responses", response), startedAt: Date.parse("2026-01-01T10:00:00Z") + at * 1000 })
  if (typeof built === "string") throw new Error(built)
  return built
}

// Call 1 sends 20,000 tokens and reads nothing. Call 2 extends it but reads only 10,368:
// about 9,600 tokens of a prefix that should have been cached were processed again.
const run = (writes: number | undefined, secondRead = 10_368) =>
  analyze([record(first, responses(20_000, 0, writes), 0), record(second, responses(21_000, secondRead, writes === undefined ? undefined : 0), 10)], { pricing }).turns[1]!

describe("OpenAI cache writes", () => {
  test("field absent: recorded as null, and the partial miss is found", () => {
    expect(normalizeUsage("openai", responses(20_000, 0).response.usage).cache_write_tokens).toBeNull()
    expect(run(undefined)).toMatchObject({ status: "partial", expected_cached_tokens: 19_968, lost_tokens: 9_600 })
  })

  test("field present and zero, with a prefix that should have been cached: recorded as 0, and still a partial miss", () => {
    expect(normalizeUsage("openai", responses(20_000, 0, 0).response.usage)).toMatchObject({ input_tokens: 20_000, cache_read_tokens: 0, cache_write_tokens: 0 })
    expect(run(0)).toMatchObject({ status: "partial", expected_cached_tokens: 19_968, lost_tokens: 9_600 })
  })

  test("field present with a real count: input excludes the writes, and the count can raise the expectation", () => {
    expect(normalizeUsage("openai", responses(20_000, 0, 20_000).response.usage)).toMatchObject({ input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 20_000 })
    expect(run(20_000, 20_000)).toMatchObject({ status: "hit", expected_cached_tokens: 20_000, lost_tokens: 0 })
    expect(run(20_000)).toMatchObject({ status: "partial", lost_tokens: 9_632 })
  })

  test("Chat Completions reads the same three shapes from prompt_tokens_details", () => {
    const chat = (writes?: number) => normalizeUsage("openai", { prompt_tokens: 5000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1000, ...(writes === undefined ? {} : { cache_write_tokens: writes }) } })
    expect(chat().cache_write_tokens).toBeNull()
    expect(chat(0)).toMatchObject({ input_tokens: 4000, cache_write_tokens: 0 })
    expect(chat(4000)).toMatchObject({ input_tokens: 0, cache_write_tokens: 4000 })
  })
})

describe("Anthropic and Gemini", () => {
  const anthropic = (read: number, write: number, gap = 10): TraceRecord => ({
    v: 1,
    ts: new Date(Date.parse("2026-01-01T10:00:00Z") + gap * 1000).toISOString(),
    provider: "anthropic",
    model: "claude-test-1",
    fidelity: "usage-only",
    usage: normalizeUsage("anthropic", { input_tokens: 20_000 - read - write, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 1 }),
  })

  test("Anthropic caches only at breakpoints, so a reported zero write is a measurement: nothing was cached", () => {
    expect(analyze([anthropic(0, 0, 0), anthropic(0, 0)], { pricing }).turns[1]).toMatchObject({ status: "uncached", expected_cached_tokens: 0 })
    expect(analyze([anthropic(0, 19_000, 0), anthropic(0, 0)], { pricing }).turns[1]).toMatchObject({ status: "miss", lost_tokens: 19_000 })
  })

  test("Anthropic without cache fields wrote nothing (it never caches implicitly)", () => {
    expect(normalizeUsage("anthropic", { input_tokens: 10, output_tokens: 1 })).toMatchObject({ cache_read_tokens: 0, cache_write_tokens: 0 })
  })

  test("Gemini never reports writes: always null, so the whole prompt is expected cached", () => {
    const gemini = (prompt: number, cached: number, at: number): TraceRecord => ({
      v: 1,
      ts: new Date(Date.parse("2026-01-01T10:00:00Z") + at * 1000).toISOString(),
      provider: "gemini",
      model: "gemini-test",
      fidelity: "usage-only",
      usage: normalizeUsage("gemini", { promptTokenCount: prompt, cachedContentTokenCount: cached, candidatesTokenCount: 1 }),
    })
    expect(gemini(20_000, 0, 0).usage.cache_write_tokens).toBeNull()
    expect(analyze([gemini(20_000, 0, 0), gemini(21_000, 10_368, 10)], { pricing }).turns[1]).toMatchObject({ status: "partial", lost_tokens: 9_600 })
  })
})
