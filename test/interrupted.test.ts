// A call the client cut off is recorded with what the stream reported so far:
// the input side (Anthropic reports it in its first event) but not all of the
// output. The report must say so wherever it shows the call.

import { describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { renderHtml } from "../src/report/html.ts"
import { renderJson } from "../src/report/json.ts"
import { renderTerminal } from "../src/report/terminal.ts"
import { parseTrace } from "../src/trace.ts"
import { TEST_PRICING } from "./helpers.ts"

const line = (ts: string, read: number, write: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, ts, provider: "anthropic", model: "claude-test-1", fidelity: "usage-only", lane: "main", usage: { input_tokens: 2, cache_read_tokens: read, cache_write_tokens: write, output_tokens: 8 }, ...extra })

const trace = [
  line("2026-01-01T10:00:00.000Z", 0, 14_000),
  line("2026-01-01T10:00:10.000Z", 14_000, 100, { interrupted: true }),
  line("2026-01-01T10:00:20.000Z", 14_100, 50),
].join("\n")

// What prefixlens 0.3's proxy wrote for a cut-off call.
const legacy = line("2026-01-01T10:00:00.000Z", 13_985, 13_164, { source: { recorder: "proxy", api: "anthropic-messages", version: "0.3.0", complete: false } })

const run = (text: string) => analyze(parseTrace(text).records, { pricing: parsePricing(TEST_PRICING), now: new Date("2026-01-02T00:00:00Z") })

describe("interrupted calls", () => {
  test("the field is read, and the 0.3 recorders' source.complete false is read as it", () => {
    expect(parseTrace(trace).records.map((record) => record.interrupted)).toEqual([undefined, true, undefined])
    expect(parseTrace(legacy).records[0]!.interrupted).toBe(true)
    // Another writer's free-form source is not interpreted.
    expect(parseTrace(line("2026-01-01T10:00:00.000Z", 0, 0, { source: { complete: false } })).records[0]!.interrupted).toBeUndefined()
    expect(parseTrace(line("2026-01-01T10:00:00.000Z", 0, 0, { interrupted: "yes" })).errors[0]).toContain("interrupted must be a boolean")
  })

  test("its input side counts as usual: hit rates and misses are unchanged, the next call is compared with it", () => {
    const analysis = run(trace)
    const plain = run(trace.replace(',"interrupted":true', ""))
    expect(analysis.turns.map((turn) => [turn.status, turn.lost_tokens, turn.hit_rate])).toEqual(plain.turns.map((turn) => [turn.status, turn.lost_tokens, turn.hit_rate]))
    expect(analysis.summary.hit_rate).toBe(plain.summary.hit_rate)
    expect(analysis.turns[1]!.interrupted).toBe(true)
    expect(analysis.summary.interrupted).toEqual([2])
    expect(plain.summary.interrupted).toEqual([])
  })

  test("all three report forms say so", () => {
    const analysis = run(trace)
    const terminal = renderTerminal(analysis)
    expect(terminal).toMatch(/hit \(cut off\)/)
    expect(terminal).toContain("Call 2 was cut off before the response ended")
    expect(terminal).toMatch(/output tokens {3}≥ 24/)
    expect(terminal).toMatch(/cost {12}≥ \$/)
    const html = renderHtml(analysis)
    expect(html).toContain("hit (cut off)")
    expect(html).toContain("Call 2 was cut off before the response ended")
    const json = JSON.parse(renderJson(analysis))
    expect(json.turns[1].interrupted).toBe(true)
    expect(json.summary.interrupted).toEqual([2])
  })

  test("a miss on a cut-off call says its cost is a lower bound", () => {
    const missed = [line("2026-01-01T10:00:00.000Z", 0, 14_000), line("2026-01-01T10:00:10.000Z", 0, 14_000, { interrupted: true })].join("\n")
    const analysis = run(missed)
    expect(analysis.turns[1]!.status).toBe("miss")
    expect(renderTerminal(analysis, { all: true })).toContain("response cut off: output and cost are lower bounds")
  })
})
