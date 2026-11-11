// Builders for small synthetic requests and trace records used across tests.

import { canonicalizeAnthropic } from "../src/canonical.ts"
import type { TraceRecord, Usage } from "../src/trace.ts"

export const TOOLS = ["read_file", "write_file", "run_shell"].map((name) => ({
  name,
  description: `Synthetic ${name} tool.`,
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}))

export const SYSTEM = "You are a synthetic test assistant. Be brief."

export interface Body {
  model?: string
  tools?: unknown[]
  system?: unknown
  messages: unknown[]
  [key: string]: unknown
}

export function body(messages: unknown[], overrides: Partial<Body> = {}): Body {
  return { model: "claude-test-1", max_tokens: 1000, tools: TOOLS, system: SYSTEM, messages, ...overrides }
}

export const user = (text: string) => ({ role: "user", content: text })
export const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
export const toolUse = (id: string, name: string) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: { path: "a.txt" } }],
})
export const toolResult = (id: string, output: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: output }],
})

export function usage(input: number, read: number, write: number | null, output = 50): Usage {
  return { input_tokens: input, cache_read_tokens: read, cache_write_tokens: write, output_tokens: output }
}

let clock = Date.parse("2026-01-01T10:00:00Z")

export function resetClock() {
  clock = Date.parse("2026-01-01T10:00:00Z")
}

/** A full-request record from an Anthropic-style body; advances a fake clock by `gapSeconds`. */
export function fullRecord(request: Body, recordUsage: Usage, extra: Partial<TraceRecord> = {}, gapSeconds = 10): TraceRecord {
  clock += gapSeconds * 1000
  const canonical = canonicalizeAnthropic(request)
  return {
    v: 1,
    ts: new Date(clock).toISOString(),
    provider: "anthropic",
    model: canonical.model,
    params: canonical.params,
    fidelity: "full-request",
    request: { blocks: canonical.blocks },
    usage: recordUsage,
    ...extra,
  }
}

export function usageRecord(model: string, recordUsage: Usage, extra: Partial<TraceRecord> = {}, gapSeconds = 10): TraceRecord {
  clock += gapSeconds * 1000
  return {
    v: 1,
    ts: new Date(clock).toISOString(),
    provider: "anthropic",
    model,
    fidelity: "usage-only",
    usage: recordUsage,
    ...extra,
  }
}

/** Pricing table used by tests: round numbers so expected costs are easy to check by hand. */
export const TEST_PRICING = {
  version: 1 as const,
  currency: "USD",
  unit: "per_million_tokens" as const,
  providers: {
    anthropic: { cache_ttl_seconds: 300, min_cacheable_tokens: 1024 },
    openai: { cache_ttl_seconds: 300, min_cacheable_tokens: 1024 },
  },
  models: [
    { provider: "anthropic", match: "claude-test-*", input: 10, output: 50, cache_read: 1, cache_write: 12.5, cache_write_1h: 20 },
    { provider: "openai", match: "gpt-test*", input: 2, output: 8, cache_read: 0.5 },
  ],
}
