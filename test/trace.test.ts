import { describe, expect, test } from "bun:test"
import { hashContent } from "../src/canonical.ts"
import { parseTrace, serializeTrace } from "../src/trace.ts"
import { normalizeUsage, promptTokens } from "../src/usage.ts"

const usageLine = { input_tokens: 1, cache_read_tokens: 2, cache_write_tokens: null, output_tokens: 3 }
const record = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00Z", provider: "openai", model: "m", fidelity: "usage-only", usage: usageLine, ...extra })

describe("parseTrace", () => {
  test("reads valid records and skips blank lines", () => {
    const result = parseTrace(`${record()}\n\n${record({ lane: "x" })}\n`)
    expect(result.errors).toEqual([])
    expect(result.records).toHaveLength(2)
    expect(result.records[1]!.lane).toBe("x")
  })

  test("reports each problem with its line number", () => {
    const result = parseTrace(
      [record({ v: 2 }), "{not json", record({ usage: { ...usageLine, input_tokens: -1 } }), record({ fidelity: "full" })].join("\n"),
    )
    expect(result.records).toHaveLength(0)
    expect(result.errors).toEqual([
      "line 1: v must be 1",
      "line 2: not valid JSON",
      "line 3: usage.input_tokens must be a non-negative integer",
      'line 4: fidelity must be "full-request" or "usage-only"',
    ])
  })

  test("full-request records need blocks, which get hashed when the hash is missing", () => {
    const content = { role: "user", content: [{ type: "text", text: "hi" }] }
    const result = parseTrace(record({ fidelity: "full-request", request: { blocks: [{ kind: "message", key: "user", content }] } }))
    expect(result.records[0]!.request!.blocks[0]!.hash).toBe(hashContent(content))
    expect(parseTrace(record({ fidelity: "full-request" })).errors[0]).toContain("request.blocks must be an array")
  })

  test("hash-only blocks are allowed; a block with neither is not", () => {
    const ok = parseTrace(record({ fidelity: "full-request", request: { blocks: [{ kind: "tool", hash: "abc" }] } }))
    expect(ok.errors).toEqual([])
    const bad = parseTrace(record({ fidelity: "full-request", request: { blocks: [{ kind: "tool" }] } }))
    expect(bad.errors[0]).toContain("needs content or hash")
  })

  test("warns when a given hash does not match the content", () => {
    const result = parseTrace(record({ fidelity: "full-request", request: { blocks: [{ kind: "tool", hash: "abc", content: { name: "x" } }] } }))
    expect(result.warnings[0]).toContain("does not match")
    expect(result.records[0]!.request!.blocks[0]!.hash).toBe("abc")
  })

  test("rejects blocks out of prefix order", () => {
    const blocks = [{ kind: "message", hash: "a" }, { kind: "tool", hash: "b" }]
    expect(parseTrace(record({ fidelity: "full-request", request: { blocks } })).errors[0]).toContain("ordered tools, system, messages")
  })

  test("round-trips through serializeTrace", () => {
    const first = parseTrace(record({ hints: [{ kind: "compaction" }, { kind: "future_kind" }] }))
    const again = parseTrace(serializeTrace(first.records))
    expect(again.records).toEqual(first.records)
  })
})

describe("normalizeUsage", () => {
  test("anthropic: input excludes cache; writes split by TTL", () => {
    const result = normalizeUsage("anthropic", {
      input_tokens: 5,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 9000,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      output_tokens: 40,
    })
    expect(result).toEqual({ input_tokens: 5, cache_read_tokens: 9000, cache_write_tokens: 300, cache_write_1h_tokens: 200, output_tokens: 40 })
    expect(promptTokens(result)).toBe(9305)
  })

  test("openai chat completions: cached tokens are inside prompt_tokens", () => {
    const result = normalizeUsage("openai", {
      prompt_tokens: 2000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 1536 },
      completion_tokens_details: { reasoning_tokens: 60 },
    })
    expect(result).toEqual({ input_tokens: 464, cache_read_tokens: 1536, cache_write_tokens: null, output_tokens: 100, reasoning_tokens: 60 })
  })

  test("openai responses api", () => {
    const result = normalizeUsage("openai", { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 7 })
    expect(result).toEqual({ input_tokens: 176, cache_read_tokens: 1024, cache_write_tokens: null, output_tokens: 7 })
  })

  test("gemini: cachedContentTokenCount is inside promptTokenCount; thoughts count as output", () => {
    const result = normalizeUsage("gemini", { promptTokenCount: 5000, cachedContentTokenCount: 4000, candidatesTokenCount: 20, thoughtsTokenCount: 30 })
    expect(result).toEqual({ input_tokens: 1000, cache_read_tokens: 4000, cache_write_tokens: null, output_tokens: 50, reasoning_tokens: 30 })
  })

  test("detects the shape when the provider is not known", () => {
    expect(normalizeUsage("other", { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 }).cache_write_tokens).toBe(0)
    expect(normalizeUsage("other", { prompt_token_count: 10, cached_content_token_count: 4 }).cache_read_tokens).toBe(4)
  })
})
