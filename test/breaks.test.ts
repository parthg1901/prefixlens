// Declared intentional breaks (SPEC 6.1) and per-provider parameter rules
// (SPEC 8.1): the report and assertPrefixStable must agree on both.

import { beforeEach, describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { explainPrefixDiff } from "../src/assert.ts"
import { canonicalizeAnthropic, canonicalizeOpenAI } from "../src/canonical.ts"
import { comparePrefix } from "../src/diff.ts"
import { buildRecord } from "../src/index.ts"
import { paramRule } from "../src/params.ts"
import { parsePricing } from "../src/pricing.ts"
import { renderHtml } from "../src/report/html.ts"
import { renderTerminal } from "../src/report/terminal.ts"
import { parseTrace, serializeTrace, type Hint, type TraceRecord } from "../src/trace.ts"
import { assistant, body, fullRecord, resetClock, TEST_PRICING, usage, usageRecord, user } from "./helpers.ts"

const pricing = parsePricing(TEST_PRICING)
const run = (records: TraceRecord[]) => analyze(records, { pricing })

beforeEach(resetClock)

// OpenAI Responses calls, recorded the way the proxy records them.
const fn = (name: string) => ({ type: "function", name, description: `Synthetic ${name}.`, parameters: { type: "object" } })
const say = (role: string, text: string) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] })
let clock = 0
function openai(input: unknown[], prompt: number, read: number, extra: { instructions?: string; tools?: string[]; hints?: Hint[]; params?: Record<string, unknown> } = {}): TraceRecord {
  const record = buildRecord({
    api: "openai-responses",
    body: { model: "gpt-test-1", instructions: extra.instructions ?? "Base.", tools: (extra.tools ?? ["read", "shell"]).map(fn), tool_choice: "auto", input, ...extra.params },
    response: { usage: { input_tokens: prompt, input_tokens_details: { cached_tokens: read }, output_tokens: 10 }, complete: true },
    startedAt: Date.parse("2026-01-01T10:00:00Z") + ++clock * 10_000,
    session: "s1",
  })
  if (typeof record === "string") throw new Error(record)
  return extra.hints ? { ...record, hints: extra.hints } : record
}
beforeEach(() => {
  clock = 0
})

const h1 = [say("user", "Fix the bug.")]
const h2 = [...h1, say("assistant", "Looking."), say("user", "Go on.")]
const h3 = [...h2, say("assistant", "Found it."), say("user", "Ship it.")]

describe("parameters per provider", () => {
  test("OpenAI: tool_choice is not part of the cached prefix (verified on Responses)", () => {
    expect(paramRule("openai", "tool_choice")).toMatchObject({ effect: "none", evidence: "verified" })
    const records = [openai(h1, 4000, 0), openai(h2, 4300, 3968, { params: { tool_choice: "none" } }), openai(h3, 4600, 4224)]
    const result = run(records)
    expect(result.turns.map((turn) => turn.status)).toEqual(["cold", "hit", "hit"])
    expect(result.turns.every((turn) => turn.prefix_change === undefined)).toBe(true)
    // The assertion agrees: forbidding tools on a final step is a legitimate request.
    expect(explainPrefixDiff(records[0]!, records[1]!).stable).toBe(true)
    expect(explainPrefixDiff({ model: "m", instructions: "x", input: h1 }, { model: "m", instructions: "x", input: h2, tool_choice: "none" }).stable).toBe(true)
  })

  test("OpenAI: documented settings still count, and invalidate everything", () => {
    const change = comparePrefix(
      { provider: "openai", ...canonicalizeOpenAI({ model: "m", input: h1, reasoning: { effort: "low" } }) },
      { provider: "openai", ...canonicalizeOpenAI({ model: "m", input: h2, reasoning: { effort: "high" } }) },
    )
    expect(change).toMatchObject({ cause: "params_changed", detail: { keys: ["reasoning"], from: "start", evidence: { reasoning: "documented" } } })
  })

  test("Anthropic: tool_choice invalidates only the messages, as Anthropic documents", () => {
    expect(paramRule("anthropic", "tool_choice")).toMatchObject({ effect: "prefix", from: "messages", evidence: "documented" })
    const prev = canonicalizeAnthropic(body([user("a")], { tool_choice: { type: "auto" } }))
    const next = canonicalizeAnthropic(body([user("a"), assistant("b")], { tool_choice: { type: "none" } }))
    const change = comparePrefix({ provider: "anthropic", ...prev }, { provider: "anthropic", ...next })
    expect(change).toMatchObject({ cause: "params_changed", detail: { from: "messages" } })
    // So a break that keeps the tools and system prompt may change it.
    expect(explainPrefixDiff(prev, next, { provider: "anthropic", allowBreak: { after: "system", reason: "settings_change" } }).ok).toBe(true)
    expect(explainPrefixDiff(prev, next, { provider: "anthropic" }).ok).toBe(false)
  })

  test("an unclassified parameter is assumed cache-relevant; sampling parameters never are", () => {
    expect(paramRule("openai", "truncation")).toMatchObject({ effect: "prefix", evidence: "assumed" })
    expect(paramRule("some-gateway", "temperature")).toMatchObject({ effect: "none" })
    expect(paramRule(undefined, "thinking")).toMatchObject({ effect: "prefix", from: "start" })
  })
})

describe("declared intentional breaks", () => {
  test("a declared compaction that rebuilds the system prompt is intentional, not a system-prompt bug", () => {
    const records = [
      fullRecord(body([user("task")]), usage(10, 0, 5000)),
      fullRecord(body([user("summary")], { system: "New baseline after compaction." }), usage(10, 0, 3000), { hints: [{ kind: "compaction" }] }),
    ]
    const result = run(records)
    const turn = result.turns[1]!
    expect(turn.status).toBe("miss")
    expect(turn.cause?.cause).toBe("system_changed")
    expect(turn.declared_break).toMatchObject({ reasons: ["compaction"], intentional: true, checked: true })
    expect(result.summary.misses).toBe(0)
    expect(result.summary.by_group).toEqual([])
    expect(result.summary.intentional).toEqual({ breaks: 1, by_reason: [{ reason: "compaction", breaks: 1, cost: turn.miss_cost! }] })
    expect(result.summary.cost!.intentional).toBe(turn.miss_cost!)
    expect(result.summary.cost!.misses).toBe(0)
    expect(result.summary.headline).toBe(`No unexpected cache misses after the first call in each lane; 1 intentional break declared by the harness cost $${turn.miss_cost!.toFixed(2)} (1 compaction).`)
  })

  test("a declared revert excuses a history rewind", () => {
    const records = [openai(h1, 4000, 0), openai(h3, 4600, 3968), openai([...h2.slice(0, 2), say("user", "Do something else.")], 4300, 0, { hints: [{ kind: "prefix_break", reason: "revert" }] })]
    const turn = run(records).turns[2]!
    expect(turn.declared_break).toMatchObject({ reasons: ["revert"], intentional: true, checked: true })
    expect(turn.cause?.group).toBe("history rewrites")
  })

  test("a declared revert does not excuse a tool-list change: it must keep the tools and system prompt", () => {
    const records = [openai(h2, 4000, 0), openai(h1, 4000, 0, { tools: ["read"], hints: [{ kind: "prefix_break", reason: "revert" }] })]
    const result = run(records)
    const turn = result.turns[1]!
    expect(turn.cause?.cause).toBe("tools_changed")
    expect(turn.declared_break).toMatchObject({ intentional: false, checked: true })
    expect(turn.declared_break!.note).toContain("must keep the tools and system prompt unchanged")
    expect(result.summary.misses).toBe(1)
    // An explicit `after` widens it.
    const widened = run([openai(h2, 4000, 0), openai(h1, 4000, 0, { tools: ["read"], hints: [{ kind: "prefix_break", reason: "revert", after: "start" }] })])
    expect(widened.turns[1]!.declared_break?.intentional).toBe(true)
  })

  test("a declaration reaches its own call only: a second miss right after it is still a miss", () => {
    const records = [
      openai(h1, 4000, 0),
      openai([say("user", "Summary.")], 2000, 0, { instructions: "Base v2.", hints: [{ kind: "prefix_break", reason: "compaction" }] }),
      openai([say("user", "Summary, edited."), say("assistant", "ok")], 2100, 0, { instructions: "Base v2." }),
    ]
    const result = run(records)
    expect(result.turns[1]!.declared_break?.intentional).toBe(true)
    expect(result.turns[2]!.declared_break).toBeUndefined()
    expect(result.turns[2]!.cause?.cause).toBe("message_edited")
    expect(result.summary.misses).toBe(1)
    expect(result.summary.intentional.breaks).toBe(1)
  })

  test("a declaration does not excuse a miss with the prefix intact", () => {
    const result = run([openai(h1, 4000, 0), openai(h2, 4300, 0, { hints: [{ kind: "prefix_break", reason: "settings_change" }] })])
    expect(result.turns[1]!.cause?.cause).toBe("provider_side")
    expect(result.turns[1]!.declared_break).toMatchObject({ intentional: false })
    expect(result.summary.misses).toBe(1)
  })

  test("usage-only: a declared break is intentional, unchecked, and names the reason", () => {
    const result = run([usageRecord("claude-test-1", usage(10, 0, 5000)), usageRecord("claude-test-1", usage(10, 0, 4000), { hints: [{ kind: "prefix_break", reason: "revert", detail: "to message 3" }] })])
    const turn = result.turns[1]!
    expect(turn.cause).toMatchObject({ cause: "history_rewound", confidence: "inferred" })
    expect(turn.cause!.summary).toContain("declared an intentional break (revert: to message 3)")
    expect(turn.declared_break).toMatchObject({ intentional: true, checked: false })
  })

  test("the model_switch hint still declares a break", () => {
    const records = [fullRecord(body([user("a")]), usage(10, 0, 5000)), fullRecord(body([user("a"), assistant("b")], { model: "claude-test-2" }), usage(10, 0, 5100), { hints: [{ kind: "model_switch" }] })]
    expect(run(records).turns[1]!.declared_break).toMatchObject({ reasons: ["model_switch"], intentional: true })
  })

  test("the report and assertPrefixStable agree on every pair", () => {
    const pairs: [TraceRecord, TraceRecord][] = [
      [openai(h2, 4000, 0), openai(h1, 4000, 0, { tools: ["read"], hints: [{ kind: "prefix_break", reason: "revert" }] })],
      [openai(h3, 4000, 0), openai(h1, 4000, 0, { hints: [{ kind: "prefix_break", reason: "refusal" }] })],
      [openai(h3, 4000, 0), openai(h1, 4000, 0, { instructions: "New.", hints: [{ kind: "compaction" }] })],
      [openai(h3, 4000, 0), openai(h1, 4000, 0, { instructions: "New.", hints: [{ kind: "prefix_break", reason: "refusal" }] })],
      [openai(h3, 4000, 0), openai(h1, 4000, 0, { params: { reasoning: { effort: "high" } }, hints: [{ kind: "prefix_break", reason: "settings_change", after: "system" }] })],
      [openai(h3, 4000, 0), openai(h1, 4000, 0, { params: { reasoning: { effort: "high" } }, hints: [{ kind: "prefix_break", reason: "settings_change" }] })],
    ]
    const verdicts = pairs.map(([prev, next]) => {
      const reported = run([prev, next]).turns[1]!.declared_break!.intentional
      expect(explainPrefixDiff(prev, next).ok).toBe(reported)
      expect(explainPrefixDiff(prev, next, { hints: next.hints }).ok).toBe(reported)
      const declared = next.hints![0]!
      const allowBreak = declared.kind === "prefix_break" ? { reason: declared.reason!, ...(declared.after ? { after: declared.after } : {}) } : declared.kind
      expect(explainPrefixDiff({ ...prev, hints: undefined }, { ...next, hints: undefined }, { allowBreak }).ok).toBe(reported)
      return reported
    })
    expect(verdicts).toEqual([false, true, true, false, false, true])
  })

  test("allowBreak with a reason only reaches as far as that reason does", () => {
    const prev = { model: "m", instructions: "x", tools: [fn("read")], input: h3 }
    const reverted = { ...prev, input: h1 }
    expect(explainPrefixDiff(prev, reverted, { allowBreak: "revert" }).ok).toBe(true)
    const failed = explainPrefixDiff(prev, { ...reverted, tools: [] }, { allowBreak: "revert" })
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain("a break was allowed (revert) only after block 2 (the tools and system prompt must stay)")
    expect(explainPrefixDiff(prev, { ...reverted, tools: [] }, { allowBreak: "compaction" }).ok).toBe(true)
  })
})

describe("reading declarations", () => {
  const line = (hints: unknown) => JSON.stringify({ v: 1, ts: "2026-01-01T10:00:00Z", provider: "openai", model: "m", fidelity: "usage-only", usage: usage(1, 0, null), hints })

  test("a valid prefix_break hint is kept; a malformed one is dropped with a warning, never trusted", () => {
    const parsed = parseTrace(
      [
        line([{ kind: "prefix_break", reason: "revert", after: { message: 2 } }]),
        line([{ kind: "prefix_break" }]),
        line([{ kind: "prefix_break", reason: "revert", after: "middle" }]),
      ].join("\n"),
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.records.map((record) => record.hints)).toEqual([[{ kind: "prefix_break", reason: "revert", after: { message: 2 } }], [], []])
    expect(parsed.warnings).toEqual([
      "line 2: hints[0] (prefix_break) needs a non-empty string reason; ignored",
      'line 3: hints[0] (prefix_break) has an invalid after (use "start", "tools", "system", a block count, or {"message": n}); ignored',
    ])
  })

  test("a trace with declarations round-trips through the writer", () => {
    const records = [openai(h1, 4000, 0), openai(h1, 4000, 0, { hints: [{ kind: "prefix_break", reason: "refusal", detail: "exchange 3 refused" }] })]
    expect(parseTrace(serializeTrace(records)).records[1]!.hints).toEqual([{ kind: "prefix_break", reason: "refusal", detail: "exchange 3 refused" }])
  })
})

describe("reports", () => {
  const trace = () => [
    openai(h1, 4000, 0),
    openai(h2, 4300, 3968),
    openai([say("user", "Summary.")], 2000, 0, { instructions: "Base v2.", hints: [{ kind: "prefix_break", reason: "compaction", detail: "compaction c1" }] }),
    openai([say("user", "Summary."), say("assistant", "Next?")], 2200, 0, { instructions: "Base v2. 10:41" }),
  ]

  test("the terminal tells intentional breaks from misses", () => {
    const text = renderTerminal(run(trace()))
    expect(text).toContain("intentional break (compaction): system prompt changed")
    expect(text).toContain("miss: system prompt changed (part 1 of 1 edited)")
    expect(text).toContain("Intentional breaks (declared by the harness; their cost is shown, not counted as misses)")
    expect(text).toContain("declared by the harness (compaction c1); the change is where the declaration allows")
    expect(text).toContain("1 miss · 1 intentional break")
    expect(text).toMatch(/lost to misses · \$[\d.]+ on intentional breaks/)
  })

  test("the HTML report has a section and a card for intentional breaks", () => {
    const html = renderHtml(run(trace()))
    expect(html).toContain("<h2>Intentional breaks</h2>")
    expect(html).toContain('<details class="miss intentional" id="turn-3"')
    expect(html).toContain('<details class="miss miss" id="turn-4"')
    expect(html).toContain('<tr class="intentional" data-status="miss">')
    expect(html).toContain('<div class="card intentional">')
  })
})
