import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { findAdapter } from "../src/adapters/index.ts"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { parseTrace, serializeTrace } from "../src/trace.ts"
import { TEST_PRICING } from "./helpers.ts"

const fixtures = path.join(import.meta.dir, "fixtures")
const codexDir = path.join(fixtures, "codex")
const newer = path.join(codexDir, "2026/01/01/rollout-2026-01-01T10-00-00-00000000-0000-4000-8000-0000000c0de1.jsonl")
const older = path.join(codexDir, "2026/01/02/rollout-2026-01-02T09-00-00-00000000-0000-4000-8000-0000000c0de2.jsonl")
const pricing = parsePricing(TEST_PRICING)
const codex = findAdapter("codex")!
const otel = findAdapter("otel")!
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-codex-otel-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

describe("codex adapter", () => {
  test("is registered as usage-only", () => {
    expect(codex.fidelity).toBe("usage-only")
    expect(otel.fidelity).toBe("usage-only")
    expect(codex.defaultPath).toBe("~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl")
  })

  test("newer rollouts: one record per token_usage_record, ignoring the repeated token_count events", async () => {
    const { records, warnings } = await codex.import(newer, {})
    expect(records.map((record) => [record.id, record.lane, record.model])).toEqual([
      ["resp_1", "main", "gpt-test-1"],
      ["resp_2", "main", "gpt-test-1"],
      ["resp_3", "main", "gpt-test-1"],
      ["resp_sub", "thread-synthetic-sub", "gpt-test-1"],
      ["resp_4", "main", "gpt-test-1"],
    ])
    expect(records[0]).toMatchObject({
      session: "00000000-0000-4000-8000-0000000c0de1",
      ts: "2026-01-01T10:00:05.000Z",
      provider: "openai",
      fidelity: "usage-only",
      source: { adapter: "codex", version: "0.999.0" },
    })
    expect(warnings).toEqual([expect.stringContaining("when each response finished")])
  })

  test("maps OpenAI-convention usage: input includes cached and cache-write tokens", async () => {
    const { records } = await codex.import(newer, {})
    expect(records[0]!.usage).toEqual({ input_tokens: 2000, cache_read_tokens: 0, cache_write_tokens: null, output_tokens: 100, reasoning_tokens: 40 })
    expect(records[1]!.usage).toEqual({ input_tokens: 700, cache_read_tokens: 1900, cache_write_tokens: null, output_tokens: 50 })
    expect(records[3]!.usage).toEqual({ input_tokens: 500, cache_read_tokens: 1000, cache_write_tokens: 1500, output_tokens: 20 })
  })

  test("compactions and collaboration-mode switches become hints on the next call", async () => {
    const { records } = await codex.import(newer, {})
    expect(records[2]!.hints).toEqual([
      { kind: "compaction", detail: "history compacted" },
      { kind: "agent_switch", detail: "default → plan" },
    ])
    expect(records.filter((record) => record.hints).length).toBe(1)
  })

  test("analysis infers compaction and expiry causes", async () => {
    const { records } = await codex.import(newer, {})
    const turns = analyze(records, { pricing }).turns
    expect(turns.map((turn) => [turn.status, turn.cause?.cause])).toEqual([
      ["cold", "cold_start"],
      ["hit", undefined],
      ["miss", "compaction"],
      ["cold", "cold_start"],
      ["miss", "cache_expired"],
    ])
  })

  test("older rollouts: token_count events, deduped by an unchanged running total", async () => {
    const { records } = await codex.import(older, {})
    expect(records.map((record) => [record.model, record.ts, record.id])).toEqual([
      ["gpt-test-1", "2026-01-02T09:00:04.000Z", undefined],
      ["gpt-test-2", "2026-01-02T09:00:14.000Z", undefined],
    ])
    expect(records[1]!.usage).toEqual({ input_tokens: 1500, cache_read_tokens: 200, cache_write_tokens: null, output_tokens: 30, reasoning_tokens: 10 })
    expect(records[0]!.source).toEqual({ adapter: "codex", version: "0.1.0" })
    expect(analyze(records, { pricing }).turns[1]!.cause?.cause).toBe("model_changed")
  })

  test("a directory imports every rollout under it as its own session", async () => {
    const { records } = await codex.import(codexDir, {})
    expect(records.length).toBe(7)
    expect([...new Set(records.map((record) => record.session))]).toEqual(["00000000-0000-4000-8000-0000000c0de1", "00000000-0000-4000-8000-0000000c0de2"])
    const only = await codex.import(codexDir, { session: "00000000-0000-4000-8000-0000000c0de2", subagents: false })
    expect(only.records.length).toBe(2)
    expect((await codex.import(newer, { subagents: false })).records.map((record) => record.lane)).not.toContain("thread-synthetic-sub")
  })

  test("records survive a trace round trip", async () => {
    const { records } = await codex.import(codexDir, {})
    expect(parseTrace(serializeTrace(records))).toEqual({ records, errors: [], warnings: [] })
  })
})

describe("otel adapter", () => {
  test("OTLP/JSON export: chat spans with usage, sorted by start time", async () => {
    const { records, warnings } = await otel.import(path.join(fixtures, "otel/export.json"), {})
    // The execute_tool span is dropped even though it carries a usage attribute.
    expect(records.map((record) => [record.id, record.ts, record.provider, record.model, record.session])).toEqual([
      ["msg_synthetic_1", "2026-01-01T10:00:00.000Z", "anthropic", "claude-test-1", "conv-synthetic"],
      ["0000000000000002", "2026-01-01T10:00:30.000Z", "anthropic", "claude-test-1", "conv-synthetic"],
      ["0000000000000004", "2026-01-01T10:10:00.000Z", "anthropic", "claude-test-1", "conv-synthetic"],
    ])
    expect(records.map((record) => record.usage)).toEqual([
      { input_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 2000, output_tokens: 50 },
      { input_tokens: 10, cache_read_tokens: 2000, cache_write_tokens: 1000, output_tokens: 40 },
      { input_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 2090, output_tokens: 30 },
    ])
    expect(records[0]!.source).toEqual({ adapter: "otel", provider_name: "anthropic", scope: "synthetic.instrumentation", scope_version: "0.0.1" })
    expect(warnings).toEqual([expect.stringContaining("assumed it does")])
    const turns = analyze(records, { pricing }).turns
    expect(turns.map((turn) => [turn.status, turn.cause?.cause])).toEqual([
      ["cold", "cold_start"],
      ["hit", undefined],
      ["miss", "cache_expired"],
    ])
  })

  test("JSONL: deprecated names, plain attribute objects, bare spans, and input reported without cache", async () => {
    const { records, warnings } = await otel.import(path.join(fixtures, "otel/spans.jsonl"), {})
    expect(records.map((record) => [record.provider, record.model, record.session, record.lane])).toEqual([
      ["openai", "gpt-test-1", undefined, "main"],
      ["openai", "gpt-test-1", undefined, "main"],
      ["gemini", "gemini-test", undefined, "main"],
    ])
    expect(records.map((record) => record.usage)).toEqual([
      { input_tokens: 1800, cache_read_tokens: 0, cache_write_tokens: null, output_tokens: 60, reasoning_tokens: 20 },
      { input_tokens: 200, cache_read_tokens: 1700, cache_write_tokens: null, output_tokens: 10 },
      { input_tokens: 1200, cache_read_tokens: 0, cache_write_tokens: null, output_tokens: 5 },
    ])
    expect(warnings).toContain("1 spans reported more cache tokens than input_tokens; their input_tokens was taken to exclude cached tokens")
  })

  test("a JSON array of spans is accepted", async () => {
    const file = path.join(fixtures, "otel/spans.jsonl")
    const spans = (await Bun.file(file).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .flatMap((value) => value.resourceSpans?.[0].scopeSpans[0].spans ?? [value])
    const array = path.join(temp, "spans.json")
    await Bun.write(array, JSON.stringify(spans))
    const { records } = await otel.import(array, {})
    expect(records.length).toBe(3)
  })

  test("a file without GenAI usage spans is an error", async () => {
    await expect(otel.import(older, {})).rejects.toThrow(
      "no GenAI spans with token usage",
    )
  })
})
