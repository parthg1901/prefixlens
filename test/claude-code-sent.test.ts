// What the Claude Code importer knows of each request, compared with what the
// proxy records of the same request as sent: Claude Code's transport adds a
// first system block it never logs (a billing-attribution line) and sends the
// logged `betas` as a header. The importer places an unknown block there, so
// both traces agree on every other block and every breakpoint.

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { importClaudeCode } from "../src/adapters/claude-code.ts"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { buildRecord } from "../src/record/exchange.ts"
import { renderTerminal } from "../src/report/terminal.ts"
import { parseTrace, serializeTrace, type Block, type TraceRecord } from "../src/trace.ts"
import { TEST_PRICING } from "./helpers.ts"

const fixture = path.join(import.meta.dir, "fixtures", "claude-code-session.jsonl")
const pricing = parsePricing({ ...TEST_PRICING, models: [...TEST_PRICING.models, { match: ["claude-*"], input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 }] })
const ATTRIBUTION = "x-anthropic-billing-header: synthetic attribution line"

// The request as Claude Code sent it, rebuilt from what the importer recorded plus the block it could not see.
function sentBody(record: TraceRecord): Record<string, unknown> {
  const blocks = record.request!.blocks
  const mark = (block: Block, value: Record<string, unknown>) => (block.breakpoint ? { ...value, cache_control: { type: "ephemeral", ttl: "1h" } } : value)
  const markLast = (block: Block, message: Record<string, unknown>) => {
    if (!block.breakpoint) return message
    const parts = message.content as Record<string, unknown>[]
    return { ...message, content: [...parts.slice(0, -1), { ...parts.at(-1)!, cache_control: { type: "ephemeral", ttl: "1h" } }] }
  }
  return {
    model: record.model,
    ...record.params,
    stream: true,
    metadata: { user_id: "synthetic-claude-code-user" },
    tools: blocks.filter((block) => block.kind === "tool").map((block) => mark(block, block.content as Record<string, unknown>)),
    system: [{ type: "text", text: ATTRIBUTION }, ...blocks.filter((block) => block.kind === "system" && !block.unknown).map((block) => mark(block, block.content as Record<string, unknown>))],
    messages: blocks.filter((block) => block.kind === "message").map((block) => markLast(block, block.content as Record<string, unknown>)),
  }
}

describe("the Claude Code importer and the proxy, on the same request", () => {
  test("agree on every block but the attribution line, on breakpoints, params and the beta header", async () => {
    const [imported] = (await importClaudeCode(fixture, { subagents: false })).records
    expect(imported!.source?.request).toBe("verified")
    expect(imported!.params).not.toHaveProperty("betas")
    expect(imported!.headers).toEqual({ "anthropic-beta": "synthetic-beta-2026-01-01,synthetic-beta-2026-02-02" })
    const proxied = buildRecord({
      api: "anthropic-messages",
      body: sentBody(imported!),
      response: { usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 40 }, complete: true },
      startedAt: imported!.ts,
      headers: { "anthropic-beta": "synthetic-beta-2026-01-01,synthetic-beta-2026-02-02" },
    }) as TraceRecord
    const [a, b] = [imported!.request!.blocks, proxied.request!.blocks]
    expect(a.map((block) => [block.kind, block.breakpoint ?? false])).toEqual(b.map((block) => [block.kind, block.breakpoint ?? false]))
    const differing = a.flatMap((block, index) => (block.hash === b[index]!.hash ? [] : [index]))
    expect(differing).toEqual([a.findIndex((block) => block.unknown)])
    expect(proxied.params).toEqual(imported!.params)
    expect(proxied.headers).toEqual(imported!.headers)
    expect(proxied.cache_ttl_seconds).toBe(imported!.cache_ttl_seconds)
  })

  test("the unknown block survives a trace round trip, and the reader checks its form", async () => {
    const { records } = await importClaudeCode(fixture, { subagents: false })
    expect(parseTrace(serializeTrace(records)).records).toEqual(records)
    const line = (block: Record<string, unknown>) => JSON.stringify({ v: 1, ts: "2026-01-01T10:00:00Z", provider: "anthropic", model: "m", fidelity: "full-request", request: { blocks: [block] }, usage: { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 } })
    expect(parseTrace(line({ kind: "system", hash: "unknown:x", unknown: true })).errors).toEqual([])
    expect(parseTrace(line({ kind: "system", hash: "unknown:x", unknown: true, content: { a: 1 } })).errors[0]).toContain("needs a placeholder hash and no content")
  })

  test("the report says the system prompt is partly unknown, and still names the tool-list change", async () => {
    const { records } = await importClaudeCode(fixture, { subagents: false })
    const analysis = analyze(records, { pricing })
    expect(analysis.turns[2]!.cause).toMatchObject({ cause: "tools_changed", confidence: "confirmed" })
    expect(renderTerminal(analysis)).toContain("3 of 3 calls were sent with a block whose content the log does not record (for Claude Code, the billing-attribution line it puts first in the system prompt), so their system prompt is partly unknown")
  })
})
