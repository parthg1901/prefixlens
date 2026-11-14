// `classifyMisses` and `prefixlens check`: one class per call, and an exit code.

import Anthropic from "@anthropic-ai/sdk"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { analyze, classifyMisses, parsePricing, renderCheck, renderCheckJson, serializeTrace, type CheckOptions, type TraceRecord } from "../src/index.ts"
import { recordRequests } from "../src/test.ts"
import { assistant, body, fullRecord, resetClock, TEST_PRICING, TOOLS, usage, usageRecord, user } from "./helpers.ts"

const root = path.join(import.meta.dir, "..")
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-check-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
beforeEach(resetClock)

const pricing = parsePricing(TEST_PRICING)
const check = (records: TraceRecord[], options?: CheckOptions) => classifyMisses(analyze(records, { pricing }), options)

const m1 = [user("task")]
const m2 = [...m1, assistant("on it"), user("go on")]
const m3 = [...m2, assistant("done"), user("next")]
const moreTools = [...TOOLS, { name: "web_fetch", description: "Synthetic.", input_schema: {} }]

// A trace with one call of each class a recorded run can hold.
function mixed(): TraceRecord[] {
  return [
    fullRecord(body(m1), usage(10, 0, 5000)), // 1 cold start
    fullRecord(body(m2), usage(10, 5000, 300)), // 2 ok
    fullRecord(body(m3, { tools: moreTools }), usage(10, 0, 5700)), // 3 avoidable: the tool list changed
    fullRecord(body([...m3, assistant("a"), user("b")], { tools: moreTools }), usage(10, 0, 5900), {}, 400), // 4 expiry
    fullRecord(body([...m3, assistant("a"), user("b"), assistant("c"), user("d")], { tools: moreTools }), usage(10, 0, 6100)), // 5 provider-side
    fullRecord(body([user("Summary of the work so far.")], { tools: moreTools }), usage(10, 600, 900), { hints: [{ kind: "prefix_break", reason: "compaction" }] }), // 6 intentional
  ]
}

describe("classifyMisses", () => {
  test("each call gets one class; avoidable misses fail, expiry, provider-side misses, cold starts and declared breaks pass", () => {
    const result = check(mixed())
    expect(result.calls.map((call) => [call.turn, call.class, call.fails])).toEqual([
      [1, "cold-start", false],
      [2, "ok", false],
      [3, "avoidable", true],
      [4, "expiry", false],
      [5, "provider-side", false],
      [6, "intentional", false],
    ])
    expect(result.ok).toBe(false)
    expect(result.fail_on).toEqual(["avoidable", "undeclared-change"])
    expect(result.counts).toEqual({ avoidable: 1, "undeclared-change": 0, unexplained: 0, intentional: 1, expiry: 1, "provider-side": 1, "cold-start": 1, "warm-start": 0, ok: 1 })
    expect(result.calls[2]).toMatchObject({
      cause: "tools_changed",
      summary: "tool list changed (+1 tool: 3 → 4)",
      block: '4 (system part 1, now tool "web_fetch")',
      lost_tokens: 5300,
      baseline_turn: 2,
      fix: "keep one tool list for the whole session (refuse a disallowed tool when it is called rather than removing it), or change it only at a deliberate breakpoint such as a compaction.",
    })
    expect(result.calls[2]!.diff).toContain("+ web_fetch")
    expect(result.calls[2]!.miss_cost).toBeGreaterThan(0)
    expect(result.calls[5]!.summary).toEndWith("(declared: compaction)")
    // What `prefixlens check` prints, from the same object.
    expect(renderCheck(result, { title: "run.trace.jsonl" })).toStartWith("prefixlens check: run.trace.jsonl\nFAIL: 1 of 6 calls\n\n  turn 3: avoidable miss [tools_changed], tool list changed (+1 tool: 3 → 4)\n")
    expect(JSON.parse(renderCheckJson(result, { trace: "run.trace.jsonl" }))).toMatchObject({ check: "prefixlens", trace: "run.trace.jsonl", ok: false, counts: result.counts })
  })

  test("failOn turns the passing classes into failures; allow makes a cause intentional", () => {
    const strict = check(mixed(), { failOn: ["expiry", "provider-side", "cold-start", "intentional"] })
    expect(strict.calls.filter((call) => call.fails).map((call) => call.turn)).toEqual([1, 3, 4, 5, 6])
    expect(strict.fail_on).toEqual(["avoidable", "undeclared-change", "intentional", "expiry", "provider-side", "cold-start"])
    expect(strict.calls[3]!.fix).toStartWith("send the next call within the cache lifetime")
    const allowed = check(mixed(), { allow: ["tools_changed"] })
    expect(allowed.ok).toBe(true)
    expect(allowed.calls[2]).toMatchObject({ class: "intentional", fails: false, summary: "tool list changed (+1 tool: 3 → 4) (allowed: tools_changed)" })
    expect(allowed.calls[2]!.fix).toBeUndefined()
  })

  test("a usage-only miss with no known cause is unexplained and passes unless asked to fail", () => {
    const records = [usageRecord("claude-test-1", usage(10, 0, 5000)), usageRecord("claude-test-1", usage(10, 0, 5200))]
    const result = check(records)
    expect(result.calls[1]).toMatchObject({ class: "unexplained", fails: false, cause: "unknown" })
    expect(result.calls[1]!.fix).toStartWith("this call is recorded with usage only")
    expect(result.ok).toBe(true)
    expect(check(records, { failOn: ["unexplained"] }).ok).toBe(false)
    // A cause the harness logged makes it avoidable; a declared break makes it intentional.
    expect(check([records[0]!, { ...records[1]!, hints: [{ kind: "tools_changed", detail: "+1 tool" }] }]).calls[1]).toMatchObject({ class: "avoidable", fails: true })
    expect(check([records[0]!, { ...records[1]!, hints: [{ kind: "prefix_break", reason: "revert" }] }]).calls[1]).toMatchObject({ class: "intentional", fails: false })
  })

  test("a prefix change that cost nothing on its call still fails, unless it is declared", () => {
    // Nothing cached yet (no cache writes), so no tokens are lost: the request still does not extend the one before it.
    const rewritten = body([user("task, reworded"), ...m2.slice(1), assistant("done"), user("next")])
    const quiet = [fullRecord(body(m2), usage(900, 0, 0)), fullRecord(rewritten, usage(950, 0, 0))]
    const result = check(quiet)
    expect(result.calls[1]).toMatchObject({ class: "undeclared-change", fails: true, cause: "message_edited", lost_tokens: 0, block: "5 (message #1, user)" })
    expect(result.calls[1]!.summary).toEndWith("no cached tokens were lost on this call, but the request does not extend the one before it")
    expect(result.calls[1]!.fix).toStartWith("replay sent messages byte for byte")
    const declared = check([quiet[0]!, { ...quiet[1]!, hints: [{ kind: "prefix_break", reason: "revert" }] }])
    expect(declared.calls[1]).toMatchObject({ class: "ok", fails: false })
    expect(check(quiet, { allow: ["message_edited"] }).calls[1]).toMatchObject({ class: "intentional", fails: false })
  })

  test("a prefix change found beside an expiry fails; one after the last cache breakpoint, or in another conversation, does not", () => {
    const expired = check([fullRecord(body(m2), usage(10, 0, 5000)), fullRecord(body(m3, { tools: moreTools }), usage(10, 0, 5700), {}, 400)])
    expect(expired.calls[1]).toMatchObject({ class: "undeclared-change", fails: true, cause: "tools_changed" })
    expect(expired.calls[1]!.summary).toEndWith("the cache had expired by then, so the change cost nothing more on this call")

    // The breakpoint is on the system prompt; the edit is in a message after it, which the provider never cached.
    const system = [{ type: "text", text: "You are a synthetic test assistant.", cache_control: { type: "ephemeral" } }]
    const afterBreakpoint = check([fullRecord(body(m2, { system }), usage(300, 0, 5000)), fullRecord(body([...m2.slice(0, 2), user("go on, please")], { system }), usage(300, 5000, 0))])
    expect(afterBreakpoint.calls[1]).toMatchObject({ class: "ok", fails: false })

    // Same tools and system prompt, no message in common: a second conversation, not a rewritten one.
    const second = check([fullRecord(body(m2), usage(900, 0, 0)), fullRecord(body([user("another task")]), usage(700, 0, 0))])
    expect(second.calls[1]).toMatchObject({ class: "ok", fails: false })
  })

  test("a first call that read a cache is a warm start", () => {
    const result = check([fullRecord(body(m1), usage(10, 5000, 0))])
    expect(result.calls[0]).toMatchObject({ class: "warm-start", fails: false })
    expect(check([fullRecord(body(m1), usage(10, 5000, 0))], { failOn: ["warm-start"] }).ok).toBe(false)
  })
})

describe("prefixlens check", () => {
  function run(args: string[], stdin?: string) {
    const result = Bun.spawnSync(["bun", path.join(root, "src/cli.ts"), "check", ...args], {
      cwd: temp,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      env: { ...process.env, NO_COLOR: "1", PREFIXLENS_PRICING: "", XDG_CACHE_HOME: path.join(temp, "cache") },
    })
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
  const write = (name: string, records: TraceRecord[]) => {
    const file = path.join(temp, name)
    writeFileSync(file, serializeTrace(records))
    return file
  }
  const fixture = path.join(root, "test", "fixtures", "agent-session.jsonl")

  test("exit 1 and the offending call, with its cause, the changed block and the fix", () => {
    const result = run([fixture])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe(
      [
        "prefixlens check: agent-session.jsonl",
        "FAIL: 1 of 5 calls",
        "",
        "  turn 4: avoidable miss [tools_changed], tool list changed (+1 tool: 3 → 4)",
        "    lost 49,000 of 49,000 cached tokens (~$0.24) · vs turn 3",
        '    changed block: 4 (system part 1, now tool "web_search")',
        "    + web_search",
        "    fix: keep one tool list for the whole session (refuse a disallowed tool when it is called rather than removing it), or change it only at a deliberate breakpoint such as a compaction.",
        "",
        "5 calls: 1 avoidable miss, 1 cold start, 3 ok",
        "",
      ].join("\n"),
    )
  })

  test("exit 0 when nothing the harness controls broke the cache", () => {
    const passing = run([write("passing.trace.jsonl", [mixed()[0]!, mixed()[1]!])])
    expect(passing.code).toBe(0)
    expect(passing.stdout).toBe("prefixlens check: passing.trace.jsonl\nok: no call lost cached tokens for a reason the harness controls, and no prefix change is undeclared\n\n2 calls: 1 cold start, 1 ok\n")
    const allowed = run([fixture, "--allow", "tools_changed"])
    expect(allowed.code).toBe(0)
    expect(allowed.stdout).toContain("5 calls: 1 intentional break, 1 cold start, 3 ok")
  })

  test("--fail-on makes the passing classes fail", () => {
    resetClock()
    const trace = write("mixed.trace.jsonl", mixed())
    expect(run([trace, "--allow", "tools_changed"]).code).toBe(0)
    const strict = run([trace, "--allow", "tools_changed", "--fail-on", "expiry,provider-side"])
    expect(strict.code).toBe(1)
    expect(strict.stdout).toContain("FAIL: 2 of 6 calls")
    expect(strict.stdout).toContain("  turn 4: cache expiry [cache_expired], prefix unchanged, cache expired: 6m 40s since the previous call (TTL 5m)")
    expect(strict.stdout).toContain("  turn 5: provider-side miss [provider_side], prefix unchanged and within TTL")
    expect(strict.stdout).toContain("6 calls: 2 intentional breaks, 1 cache expiry, 1 provider-side miss, 1 cold start, 1 ok")
  })

  test("--json prints the verdict for every call and the counts", () => {
    const result = run([fixture, "--json"])
    expect(result.code).toBe(1)
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({ check: "prefixlens", trace: fixture, ok: false, fail_on: ["avoidable", "undeclared-change"], counts: { avoidable: 1, "cold-start": 1, ok: 3 } })
    expect(parsed.calls.map((call: { turn: number; class: string; fails: boolean }) => [call.turn, call.class, call.fails])).toEqual([
      [1, "cold-start", false],
      [2, "ok", false],
      [3, "ok", false],
      [4, "avoidable", true],
      [5, "ok", false],
    ])
    expect(parsed.calls[3]).toMatchObject({ lane: "main", cause: "tools_changed", lost_tokens: 49000, baseline_turn: 3 })
  })

  test("the trace is read from stdin with -", () => {
    const result = run(["-"], serializeTrace([mixed()[0]!, mixed()[1]!]))
    expect(result.code).toBe(0)
    expect(result.stdout).toStartWith("prefixlens check: stdin\nok:")
  })

  test("exit 2 when the check cannot be made", () => {
    expect(run([])).toMatchObject({ code: 2, stderr: "prefixlens: usage: prefixlens check <trace.jsonl|-> [--fail-on <classes>] [--allow <causes>] [--json]\n" })
    expect(run([path.join(temp, "missing.jsonl")])).toMatchObject({ code: 2, stdout: "" })
    expect(run([fixture, "--fail-on", "expired"])).toMatchObject({
      code: 2,
      stderr: "prefixlens: --fail-on expired: not a class of call; choose from unexplained, intentional, expiry, provider-side, cold-start, warm-start (avoidable and undeclared-change always fail)\n",
    })
    const cause = run([fixture, "--allow", "cache_expired"])
    expect(cause.code).toBe(2)
    expect(cause.stderr).toStartWith("prefixlens: --allow cache_expired: not a cause a harness controls; choose from model_changed, params_changed, tools_changed,")
  })

  test("the trace of a test session: stable passes, a rewritten history fails as an undeclared prefix change", async () => {
    const ask = async (session: ReturnType<typeof recordRequests>, messages: Anthropic.MessageParam[]) => {
      const client = new Anthropic({ apiKey: "sk-" + "synthetic-check", fetch: session.fetch, maxRetries: 0 })
      await client.messages.create({ model: "claude-test-1", max_tokens: 100, system: "You are a synthetic agent.", messages })
    }
    const one: Anthropic.MessageParam[] = [{ role: "user", content: "One." }]
    const two: Anthropic.MessageParam[] = [...one, { role: "assistant", content: "OK." }, { role: "user", content: "Two." }]
    const stable = recordRequests()
    await ask(stable, one)
    await ask(stable, two)
    stable.writeTrace(path.join(temp, "stable.trace.jsonl"))
    expect(run([path.join(temp, "stable.trace.jsonl")]).code).toBe(0)

    const broken = recordRequests()
    await ask(broken, two)
    await ask(broken, [...two.slice(1), { role: "assistant", content: "OK." }, { role: "user", content: "Three." }])
    broken.writeTrace(path.join(temp, "broken.trace.jsonl"))
    const result = run([path.join(temp, "broken.trace.jsonl")])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("  turn 2: undeclared prefix change [oldest_messages_removed], 1 oldest message removed from the start of history")
    expect(result.stdout).toContain("    changed block: 2 (message #1, user, now message #1, assistant)")
  })
})
