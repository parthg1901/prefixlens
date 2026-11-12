import { beforeEach, describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { renderTerminal } from "../src/report/terminal.ts"
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

  test("a prefix change after the cache lifetime: expiry is the cause, and the change is reported beside it", () => {
    const rewritten = [m2[0], m2[1], toolResult("t1", "cut"), assistant("done"), user("next")]
    const pair = (gapSeconds: number, secondUsage = usage(10, 0, 5300)) => run([fullRecord(body(m2), usage(10, 0, 5000)), fullRecord(body(rewritten), secondUsage, {}, gapSeconds)])
    const late = pair(6 * 60)
    expect(late.turns[1]!.cause).toMatchObject({ cause: "cache_expired", group: "cache expiry", confidence: "confirmed", detail: { gap_seconds: 360, ttl_seconds: 300, also_changed: "tool_output_rewritten" } })
    expect(late.turns[1]!.cause!.summary).toBe(
      "cache expired: 6m since the previous call (TTL 5m); the prefix had also changed (tool output in message #3 truncated after it was sent (8 → 3 chars)), so this call would have missed within the TTL too",
    )
    expect(late.turns[1]!.prefix_change).toMatchObject({ cause: "tool_output_rewritten", confidence: "confirmed" })
    expect(late.summary.by_group.map((group) => group.group)).toEqual(["cache expiry"])
    // Within the lifetime the rewrite is the cause, as it is for a call that still read part of the cache after it:
    // a partial read shows the cache had not expired.
    expect(pair(60).turns[1]!.cause?.cause).toBe("tool_output_rewritten")
    const partial = pair(6 * 60, usage(10, 3000, 2300)).turns[1]!
    expect(partial.status).toBe("partial")
    expect(partial.cause?.cause).toBe("tool_output_rewritten")
  })

  test("a model change is still the cause after the cache lifetime: the new model never had that cache", () => {
    const records = [fullRecord(body(m1), usage(10, 0, 5000)), fullRecord(body(m2, { model: "claude-test-2" }), usage(10, 0, 5300), {}, 6 * 60)]
    expect(run(records).turns[1]!.cause?.cause).toBe("model_changed")
  })

  test("usage-only: what the harness logged before a call sent after the cache lifetime is named beside the likely expiry", () => {
    const pruned = { hints: [{ kind: "tool_output_pruned", detail: "1 output" }] }
    const late = run([usageRecord("claude-test-1", usage(10, 0, 5000)), usageRecord("claude-test-1", usage(10, 0, 4200), pruned, 6 * 60)]).turns[1]!
    expect(late.cause).toMatchObject({ cause: "cache_expired", confidence: "inferred" })
    expect(late.cause!.summary).toBe("likely cache expiry: 6m since the previous call (TTL 5m); the harness also logged pruned tool outputs (1 output) before this call; unconfirmed (usage-only)")
    // A call that still read part of the cache was not sent to an expired one: the logged pruning explains it.
    const partial = run([usageRecord("claude-test-1", usage(10, 0, 5000)), usageRecord("claude-test-1", usage(10, 3000, 1200), pruned, 6 * 60)]).turns[1]!
    expect(partial.cause?.cause).toBe("tool_output_rewritten")
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
    expect(analysis.summary.headline).toBe("1 miss cost $0.06 at list prices; 1 from provider-side misses")
  })

  test("a miss with the recorded prefix intact does not clear the harness when a block could not be recorded", () => {
    // The placeholder an importer writes for a block it knows was sent but cannot see (SPEC 4.1), first in the system prompt.
    const withUnknown = (record: TraceRecord): TraceRecord => {
      const blocks = record.request!.blocks
      return { ...record, request: { blocks: [...blocks.slice(0, TOOLS.length), { kind: "system", key: "billing-attribution", hash: "unknown:synthetic-attribution", unknown: true }, ...blocks.slice(TOOLS.length)] } }
    }
    const pair = (gapSeconds: number) => run([withUnknown(fullRecord(body(m1), usage(10, 0, 5000))), withUnknown(fullRecord(body(m2), usage(10, 0, 5300), {}, gapSeconds))]).turns[1]!
    const turn = pair(30)
    expect(turn.cause).toMatchObject({ cause: "provider_side", group: "provider-side misses", confidence: "inferred", detail: { unrecorded_block: "block 4, billing-attribution" } })
    expect(turn.cause!.summary).toBe("recorded prefix unchanged and within TTL (30s < 5m): a provider-side miss, or a change in the block the trace does not record (block 4, billing-attribution)")
    expect(pair(2).cause!.summary).toBe(
      "recorded prefix unchanged, sent 2s after the call that wrote the cache, which may not have been readable yet: a provider-side miss, or a change in the block the trace does not record (block 4, billing-attribution)",
    )
    // Expiry needs no change to explain it, so it stays confirmed.
    expect(pair(6 * 60).cause).toMatchObject({ cause: "cache_expired", confidence: "confirmed" })
  })

  test("a change after the previous call's last cache breakpoint is not blamed for a miss", () => {
    // Only the prefix through message 1 was cached; message 3 is edited, which cannot cost that cache.
    const marked = { role: "user", content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }] }
    const records = [
      fullRecord(body([marked, assistant("a"), user("draft")]), usage(10, 0, 5000)),
      fullRecord(body([marked, assistant("a"), user("draft, edited"), assistant("b"), user("more")]), usage(10, 0, 5300), {}, 30),
    ]
    const turn = run(records).turns[1]!
    expect(turn.status).toBe("miss")
    expect(turn.cause).toMatchObject({ cause: "provider_side", confidence: "confirmed" })
    expect(turn.cause!.summary).toBe(
      "cached prefix unchanged (the first change, at block 7, is after the previous call's last cache breakpoint) and within TTL (30s < 5m): provider-side miss, not caused by the harness",
    )
    expect(turn.prefix_change).toMatchObject({ cause: "message_edited", block_index: 6 })
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

  test("a deferred tool added between two calls is not a prefix change: it is not in the prompt", () => {
    const deferred = { name: "search_docs", description: "Synthetic deferred tool.", input_schema: { type: "object" }, defer_loading: true }
    const records = [fullRecord(body(m1), usage(10, 0, 5000)), fullRecord(body(m2, { tools: [...TOOLS, deferred] }), usage(10, 5000, 300))]
    const turn = run(records).turns[1]!
    expect(turn.status).toBe("hit")
    expect(turn.prefix_change).toBeUndefined()
    // The trace still shows it.
    expect(records[1]!.request!.blocks.find((block) => block.deferred)?.key).toBe("search_docs")
    // The same tool sent without deferred loading is in the prompt, and is the cause of a miss.
    const eager = [fullRecord(body(m1), usage(10, 0, 5000)), fullRecord(body(m2, { tools: [...TOOLS, { ...deferred, defer_loading: false }] }), usage(10, 0, 5300))]
    expect(run(eager).turns[1]!.cause?.summary).toBe("tool list changed (+1 tool: 3 → 4)")
  })

  test("no cache writes means nothing to miss", () => {
    const records = [fullRecord(body(m1), usage(5000, 0, 0)), fullRecord(body(m2), usage(5300, 0, 0))]
    const result = run(records)
    expect(result.turns[1]!.status).toBe("uncached")
    expect(result.summary.notes.join(" ")).toContain("nothing cacheable")
  })

  test("implicit caching (no write figure) expects the previous prompt in whole 128-token steps", () => {
    const openai = (input: number, read: number, gap = 10): TraceRecord => ({ ...usageRecord("gpt-test", usage(input, read, null), {}, gap), provider: "openai" })
    const result = run([openai(3000, 0), openai(200, 3000), openai(3300, 0), openai(1500, 1100)])
    expect(result.turns.map((turn) => turn.status)).toEqual(["cold", "hit", "miss", "partial"])
    expect(result.turns[3]!.lost_tokens).toBe(1500)
    expect(result.turns[1]!.expected_cached_tokens).toBe(2944)
    expect(result.turns[1]!.cost!.total).toBeCloseTo((200 * 2 + 3000 * 0.5 + 50 * 8) / 1e6, 10)
  })

  describe("an implicit cache that reads in steps other than 128 tokens", () => {
    // A gateway that reads floor(previous prompt / 1,088) × 1,088 tokens and reports no write figure.
    const STEP = 1088
    const PROMPTS = [7732, 8529, 8729, 9016, 9298, 9391, 9541]
    const calls = (prompts: number[], reads: Record<number, number> = {}) =>
      prompts.map((prompt, index): TraceRecord => {
        const read = reads[index] ?? (index === 0 ? 0 : Math.floor(prompts[index - 1]! / STEP) * STEP)
        return { ...usageRecord("gpt-test", usage(prompt - read, read, null)), provider: "openai" }
      })

    test("the step is learnt from the reads in the trace, and a call that read every whole step is a hit", () => {
      const result = run(calls(PROMPTS))
      expect(result.turns.map((turn) => turn.status)).toEqual(["cold", "hit", "hit", "hit", "hit", "hit", "hit"])
      // 9,298 tokens hold 8 steps of 1,088; a 128-step rule would expect 9,216 and call this 512 short.
      expect(result.turns[5]).toMatchObject({ expected_cached_tokens: 8704, lost_tokens: 0, miss_cost: 0 })
      expect(result.summary.cache_steps).toEqual([{ provider: "openai", model: "gpt-test", tokens: 1088 }])
      expect(result.summary.notes[0]).toStartWith("Cache reads for gpt-test come in steps of 1,088 tokens in this trace")
      expect(result.summary.headline).toBe("No cache misses after the first call in each lane.")
    })

    test("a read one whole step short is still a partial miss", () => {
      const turn = run(calls(PROMPTS, { 5: 7616 })).turns[5]!
      expect(turn).toMatchObject({ status: "partial", expected_cached_tokens: 8704, lost_tokens: 1088 })
    })

    test("with too few reads to learn from, the step stays 128", () => {
      // Two reads: the second call after the cold one is 832 short of the 128-step prefix of 8,529 tokens.
      const result = run(calls(PROMPTS.slice(0, 3)))
      expect(result.turns[2]).toMatchObject({ status: "partial", expected_cached_tokens: 8448, lost_tokens: 832 })
      expect(result.summary.cache_steps).toBeUndefined()
    })

    test("reads that are multiples of 128 only keep the 128-token rule: 512 short is a partial miss", () => {
      const turn = run(calls(PROMPTS, { 1: 7680, 2: 8448, 3: 8704, 4: 8960, 5: 8704 })).turns[5]!
      expect(turn).toMatchObject({ status: "partial", expected_cached_tokens: 9216, lost_tokens: 512 })
    })

    test("a request that exactly extends the previous one is a hit when less than one learnt step short", () => {
      // This provider also reports writes, so the previous call is known to have left 9,298 tokens cached; the next reads 8 whole steps.
      const history = [m1, m2, m3, [...m3, assistant("more"), user("go")], [...m3, assistant("more"), user("go"), assistant("and more"), user("on")]]
      const openai = { provider: "openai", model: "gpt-test" }
      const warm = [0, 7616, 7616, 8704].map((read, index) => fullRecord(body(history[index]!), usage(PROMPTS[index]! - read, read, 0), openai))
      const last = (messages: unknown[]) => [...warm.slice(0, 3), fullRecord(body(history[3]!), usage(100, 8704, 594), openai), fullRecord(body(messages), usage(900, 8704, 0), openai)]
      const extended = run(last(history[4]!)).turns[4]!
      expect(extended).toMatchObject({ status: "hit", expected_cached_tokens: 9298, lost_tokens: 594 })
      // The same shortfall with an edited message is a miss the harness caused.
      const edited = run(last([user("task, edited"), ...history[4]!.slice(1)])).turns[4]!
      expect(edited).toMatchObject({ status: "partial", lost_tokens: 594 })
      expect(edited.cause?.cause).toBe("message_edited")
    })
  })

  test("implicit caching below the minimum prompt size is uncached", () => {
    const openai = (input: number): TraceRecord => ({ ...usageRecord("gpt-test", usage(input, 0, null)), provider: "openai" })
    expect(run([openai(500), openai(700)]).turns[1]!.status).toBe("uncached")
  })

  test("a first call in its lane that read from the cache is a hit, shown as a warm start", () => {
    // A new session whose tools and instructions an earlier session had left cached: 7,616 of 7,718 tokens read.
    const fresh = (read: number): TraceRecord => ({ ...usageRecord("gpt-test", usage(7718 - read, read, null), { session: "s2" }), provider: "openai" })
    const result = run([fresh(7616)])
    expect(result.turns[0]).toMatchObject({ status: "hit", warm_start: true, lost_tokens: 0, expected_cached_tokens: 0, miss_cost: 0 })
    expect(result.turns[0]!.cause).toBeUndefined()
    expect(result.summary.status).toMatchObject({ cold: 0, hit: 1 })
    expect(result.summary.notes[0]).toBe(
      "1 call was the first in its lane and still read from the cache (a warm start: an earlier call outside the lane, such as another session with the same tools and instructions, had left that prefix cached). It is counted as a hit.",
    )
    expect(renderTerminal(result)).toContain("98.7%  $0.0044  hit (warm start)")
    // A first call that read nothing is cold, as before.
    const cold = run([fresh(0)])
    expect(cold.turns[0]).toMatchObject({ status: "cold", cause: { summary: "first call in this lane: nothing cached yet" } })
    expect(cold.turns[0]!.warm_start).toBeUndefined()
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
    expect(summary.headline).toMatch(/^3 misses cost \$0\.\d\d at list prices; 2 from tool-list changes, 1 from cache expiry$/)
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

  test("a miss with the prefix intact and a changed session-id header is a routing change", () => {
    const first = [user("Hi.")]
    const result = run([
      fullRecord(body(first), usage(5, 0, 2000), { headers: { "session-id": "a" } }),
      fullRecord(body([...first, assistant("Hello.")]), usage(5, 0, 2100), { headers: { "session-id": "b" } }),
    ])
    expect(result.turns[1]!.cause).toMatchObject({ cause: "params_changed", confidence: "confirmed" })
    expect(result.turns[1]!.cause!.summary).toBe("prefix unchanged, but the session-id header changed (a → b); the provider routes requests to a cache by it")
    // After the cache lifetime the header is beside the point.
    const late = run([
      fullRecord(body(first), usage(5, 0, 2000), { headers: { "session-id": "a" } }),
      fullRecord(body([...first, assistant("Hello.")]), usage(5, 0, 2100), { headers: { "session-id": "b" } }, 6 * 60),
    ])
    expect(late.turns[1]!.cause?.cause).toBe("cache_expired")
  })
})
