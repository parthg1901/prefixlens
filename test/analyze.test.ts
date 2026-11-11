import { beforeEach, describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import type { TraceRecord } from "../src/trace.ts"
import { assistant, body, fullRecord, resetClock, TEST_PRICING, TOOLS, toolResult, toolUse, usage, usageRecord, user } from "./helpers.ts"

const pricing = parsePricing(TEST_PRICING)
const run = (records: TraceRecord[]) => analyze(records, { pricing })

beforeEach(resetClock)

const m1 = [user("task")]
const m2 = [...m1, toolUse("t1", "read_file"), toolResult("t1", "contents")]
const m3 = [...m2, assistant("done"), user("next")]

describe("analyze", () => {
  test("first call is cold, an append-only follow-up is a hit", () => {
    const result = run([fullRecord(body(m1), usage(10, 0, 5000)), fullRecord(body(m2), usage(10, 5000, 300))])
    expect(result.turns.map((turn) => turn.status)).toEqual(["cold", "hit"])
    expect(result.turns[1]!.expected_cached_tokens).toBe(5000)
    expect(result.turns[1]!.hit_rate).toBeCloseTo(5000 / 5310)
    expect(result.turns[1]!.cause).toBeUndefined()
    expect(result.summary.misses).toBe(0)
    expect(result.summary.headline).toBe("No cache misses after the first call in each lane.")
  })

  test("a full miss names the first changed block and prices the lost tokens", () => {
    const records = [
      fullRecord(body(m1), usage(10, 0, 5000)),
      fullRecord(body(m2, { tools: [...TOOLS, { name: "web_fetch", description: "x", input_schema: {} }] }), usage(10, 0, 5400, 100)),
    ]
    const turn = run(records).turns[1]!
    expect(turn.status).toBe("miss")
    expect(turn.lost_tokens).toBe(5000)
    expect(turn.cause).toMatchObject({ cause: "tools_changed", group: "tool-list changes", confidence: "confirmed" })
    // Costs by hand: input 10*$10 + write 5400*$12.5 + output 100*$50, per million.
    expect(turn.cost!.total).toBeCloseTo((10 * 10 + 5400 * 12.5 + 100 * 50) / 1e6, 10)
    expect(turn.uncached_cost).toBeCloseTo((10 * 10 + 5400 * 12.5) / 1e6, 10)
    // Lost tokens were paid at the blended uncached rate instead of the $1 read rate.
    const blended = (10 * 10 + 5400 * 12.5) / 5410
    expect(turn.miss_cost).toBeCloseTo((5000 * (blended - 1)) / 1e6, 10)
  })

  test("a partial miss: only the part after the changed block is lost", () => {
    const edited = [user("task, edited"), ...m2.slice(1)]
    const records = [fullRecord(body(m2), usage(10, 4000, 1000)), fullRecord(body([...edited, user("go")]), usage(10, 3000, 2200))]
    const turn = run(records).turns[1]!
    expect(turn.status).toBe("partial")
    expect(turn.lost_tokens).toBe(2000)
    expect(turn.cause?.cause).toBe("message_edited")
  })

  test("losses within the tolerance count as hits", () => {
    const records = [fullRecord(body(m1), usage(10, 0, 5000)), fullRecord(body(m2), usage(100, 4900, 300))]
    expect(run(records).turns[1]!.status).toBe("hit")
    expect(analyze(records, { pricing, toleranceTokens: 50 }).turns[1]!.status).toBe("partial")
  })

  test("an unchanged prefix after the TTL is an expiry", () => {
    const records = [fullRecord(body(m1), usage(10, 0, 5000)), fullRecord(body(m2), usage(10, 0, 5300), {}, 6 * 60)]
    const turn = run(records).turns[1]!
    expect(turn.cause).toMatchObject({ cause: "cache_expired", confidence: "confirmed" })
    expect(turn.cause!.summary).toBe("prefix unchanged, cache expired: 6m since the previous call (TTL 5m)")
  })

  test("the record's own TTL overrides the provider default", () => {
    const records = [fullRecord(body(m1), usage(10, 0, 5000), { cache_ttl_seconds: 3600 }), fullRecord(body(m2), usage(10, 0, 5300), {}, 6 * 60)]
    expect(run(records).turns[1]!.cause?.cause).toBe("provider_side")
  })

  test("an unchanged prefix within the TTL is a provider-side miss", () => {
    const records = [fullRecord(body(m1), usage(10, 0, 5000)), fullRecord(body(m2), usage(10, 0, 5300), {}, 30)]
    const analysis = run(records)
    expect(analysis.turns[1]!.cause).toMatchObject({ cause: "provider_side", group: "provider-side misses", confidence: "confirmed" })
    expect(analysis.turns[1]!.cause!.summary).toBe("prefix unchanged and within TTL (30s < 5m): provider-side miss, not caused by the harness")
    expect(analysis.summary.headline).toBe("1 miss cost $0.06; 1 from provider-side misses")
  })

  test("a follow-up seconds after a cold write that misses with nothing changed is provider-side", () => {
    // Seen live: a request about two seconds after the call that wrote the prefix can miss.
    const records = [fullRecord(body(m1), usage(10, 0, 5000)), fullRecord(body(m2), usage(10, 0, 5300), {}, 2)]
    const turn = run(records).turns[1]!
    expect(turn.status).toBe("miss")
    expect(turn.cause).toMatchObject({ cause: "provider_side", confidence: "confirmed", detail: { fresh_write: true } })
    expect(turn.cause!.summary).toBe(
      "prefix unchanged, provider-side miss: sent 2s after the call that wrote the cache, which may not have been readable yet; not caused by the harness",
    )
  })

  test("a prefix change after the cached part is recorded but is not a miss", () => {
    // The previous call cached nothing past the system prompt, so editing message 1 costs nothing.
    const records = [fullRecord(body(m1), usage(3000, 2000, 0)), fullRecord(body([user("edited")]), usage(3000, 2000, 0))]
    const turn = run(records).turns[1]!
    expect(turn.status).toBe("hit")
    expect(turn.prefix_change?.cause).toBe("message_edited")
  })

  test("no cache writes means nothing to miss", () => {
    const records = [fullRecord(body(m1), usage(5000, 0, 0)), fullRecord(body(m2), usage(5300, 0, 0))]
    const result = run(records)
    expect(result.turns[1]!.status).toBe("uncached")
    expect(result.summary.notes.join(" ")).toContain("nothing cacheable")
  })

  test("implicit caching (no write figure) expects the whole previous prompt", () => {
    const openai = (input: number, read: number, gap = 10): TraceRecord => ({ ...usageRecord("gpt-test", usage(input, read, null), {}, gap), provider: "openai" })
    const result = run([openai(3000, 0), openai(200, 3000), openai(3300, 0), openai(1500, 1100)])
    expect(result.turns.map((turn) => turn.status)).toEqual(["cold", "hit", "miss", "partial"])
    expect(result.turns[3]!.lost_tokens).toBe(1500)
    expect(result.turns[1]!.expected_cached_tokens).toBe(3000)
    expect(result.turns[1]!.cost!.total).toBeCloseTo((200 * 2 + 3000 * 0.5 + 50 * 8) / 1e6, 10)
  })

  test("implicit caching below the minimum prompt size is uncached", () => {
    const openai = (input: number): TraceRecord => ({ ...usageRecord("gpt-test", usage(input, 0, null)), provider: "openai" })
    expect(run([openai(500), openai(700)]).turns[1]!.status).toBe("uncached")
  })

  test("lanes are compared separately", () => {
    const records = [
      fullRecord(body(m1), usage(10, 0, 5000), { lane: "main" }),
      fullRecord(body([user("subagent task")]), usage(10, 0, 3000), { lane: "agent-1" }),
      fullRecord(body(m2), usage(10, 5000, 300), { lane: "main" }),
    ]
    const result = run(records)
    expect(result.turns.map((turn) => turn.status)).toEqual(["cold", "cold", "hit"])
    expect(result.turns[2]!.baseline_turn).toBe(1)
    expect(result.summary.lanes).toEqual(["main", "agent-1"])
  })

  test("usage-only misses get inferred causes and say a full request is needed", () => {
    const records = [
      usageRecord("claude-test-1", usage(10, 0, 5000)),
      usageRecord("claude-test-1", usage(10, 0, 5100), {}, 20),
      usageRecord("claude-test-1", usage(10, 0, 5200), {}, 600),
      usageRecord("claude-test-1", usage(10, 0, 3000), { hints: [{ kind: "compaction" }] }),
      usageRecord("claude-test-2", usage(10, 0, 4000)),
      usageRecord("claude-test-2", usage(10, 0, 5000), { hints: [{ kind: "agent_switch", detail: "build → plan" }] }),
      usageRecord("claude-test-2", usage(10, 0, 6000), { hints: [{ kind: "tool_output_pruned" }] }),
    ]
    const causes = run(records).turns.slice(1).map((turn) => [turn.cause?.cause, turn.cause?.confidence])
    expect(causes).toEqual([
      ["unknown", "unknown"],
      ["cache_expired", "inferred"],
      ["compaction", "inferred"],
      ["model_changed", "confirmed"],
      ["tools_changed", "inferred"],
      ["tool_output_rewritten", "inferred"],
    ])
    const result = run(records)
    expect(result.turns[1]!.cause!.summary).toBe("cause unknown: usage-only trace: root-cause diffs need full requests")
    expect(result.summary.notes[0]).toContain("usage-only")
  })

  test("totals and the headline add up", () => {
    const records = [
      fullRecord(body(m1), usage(10, 0, 5000)),
      fullRecord(body(m2, { tools: TOOLS.slice(1) }), usage(10, 0, 5400)),
      fullRecord(body(m3, { tools: TOOLS }), usage(10, 0, 5800)),
      fullRecord(body([...m3, assistant("x")]), usage(10, 0, 6000), {}, 400),
    ]
    const result = run(records)
    const summary = result.summary
    expect(summary.misses).toBe(3)
    expect(summary.tokens).toEqual({ prompt: 22240, input: 40, cache_read: 0, cache_write: 22200, output: 200 })
    expect(summary.cost!.total).toBeCloseTo(result.turns.reduce((sum, turn) => sum + turn.cost!.total, 0), 12)
    expect(summary.cost!.misses).toBeCloseTo(result.turns.reduce((sum, turn) => sum + turn.miss_cost!, 0), 12)
    expect(summary.by_group.map((group) => [group.group, group.misses])).toEqual([
      ["tool-list changes", 2],
      ["cache expiry", 1],
    ])
    expect(summary.headline).toMatch(/^3 misses cost \$0\.\d\d; 2 from tool-list changes, 1 from cache expiry$/)
  })

  test("unpriced models leave costs null and say so", () => {
    const result = run([usageRecord("mystery-model", usage(10, 0, 100)), usageRecord("mystery-model", usage(10, 100, 0))])
    expect(result.turns[0]!.cost).toBeNull()
    expect(result.summary.cost).toBeNull()
    expect(result.summary.unpriced_models).toEqual(["mystery-model"])
  })

  test("harness-reported costs are summed separately", () => {
    const result = run([usageRecord("claude-test-1", { ...usage(10, 0, 100), reported_cost: 0.5 }), usageRecord("claude-test-1", { ...usage(10, 100, 0), reported_cost: 0.25 })])
    expect(result.summary.reported_cost).toBe(0.75)
  })
})
