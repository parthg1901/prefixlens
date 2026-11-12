import { describe, expect, test } from "bun:test"
import { canonicalizeRequest } from "../src/canonical.ts"
import { assertPrefixStable, explainPrefixDiff, PrefixBreakError } from "../src/assert.ts"
import { assistant, body, TOOLS, toolResult, toolUse, user } from "./helpers.ts"

// OpenAI Responses bodies, shaped like those of a harness that sends full history every call.
const fn = (name: string) => ({ type: "function", name, description: `Synthetic ${name}.`, parameters: { type: "object" }, strict: false })
const responsesTools = ["read_file", "write_file", "run_shell"].map(fn)
const say = (role: "user" | "developer", text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] })
const reply = (text: string) => ({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] })
const call = (id: string) => ({ type: "function_call", call_id: id, name: "read_file", arguments: '{"path":"a.txt"}' })
const output = (id: string, text: string) => ({ type: "function_call_output", call_id: id, output: text })
const responses = (input: unknown[], extra: Record<string, unknown> = {}) => ({
  model: "gpt-test-1",
  store: false,
  stream: true,
  instructions: "You are a synthetic coding agent.",
  tools: responsesTools,
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "low", summary: "auto" },
  prompt_cache_key: "synthetic-session",
  input,
  ...extra,
})

const turn1 = responses([say("user", "Fix the synthetic bug.")])
const turn2 = responses([say("user", "Fix the synthetic bug."), call("c1"), output("c1", "print(1)"), reply("Fixed.")])

function failure(prev: Record<string, unknown>, next: Record<string, unknown>, options = {}) {
  try {
    assertPrefixStable(prev, next, options)
  } catch (error) {
    expect(error).toBeInstanceOf(PrefixBreakError)
    return (error as PrefixBreakError).message
  }
  throw new Error("expected assertPrefixStable to throw")
}

describe("assertPrefixStable", () => {
  test("an appended turn is stable", () => {
    const result = assertPrefixStable(turn1, turn2)
    expect(result).toMatchObject({ stable: true, ok: true, appended: 3, unchanged: 5 })
    expect(result.message).toBe("prefix stable: all 5 blocks of the previous request are unchanged, and 3 blocks were appended")
  })

  test("transport fields and a string-vs-part rewrite are not changes", () => {
    const stringInput = responses([{ type: "message", role: "user", content: "Fix the synthetic bug." }])
    expect(explainPrefixDiff(turn1, { ...stringInput, stream: false, stream_options: { include_obfuscation: false } }).stable).toBe(true)
  })

  test("names reordered tools", () => {
    const message = failure(turn1, responses(turn2.input, { tools: [...responsesTools].reverse() }))
    expect(message).toContain("prefix not stable: tool order changed (2 of 3 tools moved; same tools, different order)")
    expect(message).toContain('first changed block: 1 of 5 (tool "read_file", now tool "run_shell"); nothing before it matches')
    expect(message).toContain("fix: build the tool list in a deterministic order")
  })

  test("names a timestamp in the system prompt", () => {
    const at = (time: string) => `You are a synthetic coding agent. Current time: 2026-01-01 ${time}.`
    const message = failure(responses(turn1.input, { instructions: at("10:41") }), responses(turn2.input, { instructions: at("10:42") }))
    expect(message).toContain("system prompt changed: a timestamp value was updated (10:41 → 10:42)")
    expect(message).toContain("first changed block: 4 of 5 (system part 1); blocks 1-3 still match")
  })

  test("names a rewritten tool output and an edited message", () => {
    const truncated = responses([say("user", "Fix the synthetic bug."), call("c1"), output("c1", "print"), reply("Fixed.")])
    expect(failure(turn2, truncated)).toContain("tool output in message #3 truncated after it was sent (8 → 5 chars)")
    const edited = responses([say("user", "Fix the synthetic bug!"), ...turn2.input.slice(1)])
    expect(failure(turn2, edited)).toContain("message #1 (user) was edited after it was sent")
  })

  test("names a tool list changed by a mode switch, and a parameter change", () => {
    expect(failure(turn2, responses(turn2.input, { tools: responsesTools.slice(0, 1) }))).toContain("tool list changed (-2 tools: 3 → 1)")
    const message = failure(turn2, responses(turn2.input, { reasoning: { effort: "high", summary: "auto" } }))
    expect(message).toContain("request parameters changed: reasoning")
    expect(message).toContain("+ reasoning.effort: high")
  })

  test("ignoreParams leaves a parameter out", () => {
    const last = responses(turn2.input, { reasoning: { effort: "high", summary: "auto" } })
    expect(explainPrefixDiff(turn2, last).ok).toBe(false)
    expect(assertPrefixStable(turn2, last, { ignoreParams: ["reasoning"] }).stable).toBe(true)
  })

  test("allowBreak: a compaction may replace history", () => {
    const compacted = responses([say("user", "Summary of the synthetic work so far.")])
    expect(failure(turn2, compacted)).toContain('if this change is intentional, pass { allowBreak: { reason: "..." } }')
    const allowed = assertPrefixStable(turn2, compacted, { allowBreak: "compaction" })
    expect(allowed).toMatchObject({ stable: false, ok: true, allowed: "compaction" })
    expect(allowed.message).toBe("prefix changed at block 5, allowed (compaction): history compacted (4 → 1 messages from message #1)")
  })

  test("allowBreak.after: tools and instructions must survive a compaction", () => {
    const compactedWithNewTools = responses([say("user", "Summary.")], { tools: responsesTools.slice(0, 2) })
    const message = failure(turn2, compactedWithNewTools, { allowBreak: { after: "system", reason: "compaction" } })
    expect(message).toContain("a break was allowed (compaction) only after block 4 (the tools and system prompt must stay), and this one is earlier")
    expect(assertPrefixStable(turn2, compactedWithNewTools, { allowBreak: { reason: "compaction" } }).ok).toBe(true)
    expect(assertPrefixStable(turn2, responses([say("user", "Fix the synthetic bug."), reply("Rewound.")]), { allowBreak: { after: { message: 1 }, reason: "rewind" } }).ok).toBe(true)
    expect(explainPrefixDiff(turn2, responses([say("user", "Rewound early.")]), { allowBreak: { after: { message: 1 } } }).ok).toBe(false)
    expect(assertPrefixStable(turn2, responses(turn2.input.slice(0, 2)), { allowBreak: { after: 6 } }).ok).toBe(true)
  })

  test("a model change fails unless the break may start anywhere", () => {
    const other = responses(turn2.input, { model: "gpt-test-2" })
    expect(failure(turn2, other)).toContain("the model changed, so nothing in the cache applies")
    expect(assertPrefixStable(turn2, other, { allowBreak: { after: "start", reason: "model switch" } }).ok).toBe(true)
  })

  test("works on Anthropic and Chat Completions bodies, canonical requests and trace records", () => {
    const a1 = body([user("Hi.")])
    const a2 = body([user("Hi."), toolUse("t1", "read_file"), toolResult("t1", "data")])
    expect(assertPrefixStable(a1, a2).appended).toBe(2)
    expect(failure(a1, body(a2.messages, { tools: [...TOOLS, { name: "web_fetch", description: "x", input_schema: { type: "object" } }] }))).toContain("tool list changed (+1 tool: 3 → 4)")
    const chat = (messages: unknown[]) => ({ model: "gpt-test-1", messages: [{ role: "system", content: "Synthetic." }, ...messages] })
    expect(assertPrefixStable(chat([user("Hi.")]), chat([user("Hi."), assistant("Hello.")])).stable).toBe(true)
    const canonical = canonicalizeRequest("anthropic", a1)
    expect(assertPrefixStable(canonical, canonicalizeRequest("anthropic", a2)).stable).toBe(true)
    const record = { v: 1, ts: "2026-01-01T10:00:00Z", provider: "anthropic", model: canonical.model, fidelity: "full-request" as const, request: { blocks: canonical.blocks }, usage: { input_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1 } }
    expect(assertPrefixStable(record, a2).stable).toBe(true)
    expect(assertPrefixStable(canonical.blocks, canonicalizeRequest("anthropic", a2).blocks).stable).toBe(true)
  })

  test("Anthropic's request-level cache_control is a breakpoint that moves, not a parameter change", () => {
    const marker = { type: "ephemeral" }
    const first = body([user("Hi.")])
    const second = body([user("Hi."), assistant("Hello."), user("Go on.")], { cache_control: marker })
    // Turning it on, and moving from a marker on the last message to the request-level one, both keep the prefix.
    expect(assertPrefixStable(first, second)).toMatchObject({ stable: true, appended: 2 })
    const marked = body([{ role: "user", content: [{ type: "text", text: "Hi.", cache_control: marker }] }])
    expect(assertPrefixStable(marked, second)).toMatchObject({ stable: true, appended: 2 })
  })

  test("a body without system or tools gets Anthropic's parameter rules when its model id is Claude's", () => {
    const bare = (toolChoice: string, messages: unknown[]) => ({ model: "claude-test-1", max_tokens: 100, tool_choice: { type: toolChoice }, messages })
    const result = explainPrefixDiff(bare("auto", [user("Hi.")]), bare("none", [user("Hi."), assistant("Hello.")]))
    expect(result.change).toMatchObject({ cause: "params_changed", summary: "request parameters changed: tool_choice", detail: { from: "messages" } })
  })

  test("a Gemini body needs provider: gemini", () => {
    const gemini = (contents: unknown[]) => ({ model: "gemini-test", systemInstruction: { parts: [{ text: "Synthetic." }] }, contents })
    const hi = { role: "user", parts: [{ text: "Hi." }] }
    expect(assertPrefixStable(gemini([hi]), gemini([hi, { role: "model", parts: [{ text: "Hello." }] }]), { provider: "gemini" }).appended).toBe(1)
  })
})
