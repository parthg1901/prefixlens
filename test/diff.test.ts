import { describe, expect, test } from "bun:test"
import { canonicalizeAnthropic, canonicalizeOpenAI } from "../src/canonical.ts"
import { CAUSE_GROUP, comparePrefix, firstDivergence, type Comparable } from "../src/diff.ts"
import { assistant, body, SYSTEM, TOOLS, toolResult, toolUse, user } from "./helpers.ts"

function view(request: ReturnType<typeof body>, extra: Partial<Comparable> = {}): Comparable {
  const canonical = canonicalizeAnthropic(request)
  return { model: canonical.model, params: canonical.params, blocks: canonical.blocks, ...extra }
}

const history = [user("start"), toolUse("t1", "read_file"), toolResult("t1", "file contents line 1\nline 2\nline 3"), assistant("done")]

describe("firstDivergence", () => {
  test("is -1 when the previous request is an unchanged prefix", () => {
    const prev = view(body(history.slice(0, 2)))
    const next = view(body(history))
    expect(firstDivergence(prev.blocks, next.blocks)).toBe(-1)
  })

  test("points at the first block whose hash differs", () => {
    const prev = view(body(history))
    const next = view(body([user("changed"), ...history.slice(1)]))
    expect(firstDivergence(prev.blocks, next.blocks)).toBe(TOOLS.length + 1)
  })
})

describe("comparePrefix", () => {
  test("an append-only conversation is stable", () => {
    expect(comparePrefix(view(body(history.slice(0, 3))), view(body(history)))).toBeNull()
  })

  test("moving cache breakpoints is not a change", () => {
    const marked = history.map((message, index) =>
      index === 2 ? { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents line 1\nline 2\nline 3", cache_control: { type: "ephemeral" } }] } : message,
    )
    expect(comparePrefix(view(body(marked)), view(body([...history, user("more")])))).toBeNull()
  })

  test("model change", () => {
    const change = comparePrefix(view(body(history)), view(body(history, { model: "claude-test-2" })))
    expect(change?.cause).toBe("model_changed")
    expect(change?.summary).toContain("claude-test-1 → claude-test-2")
  })

  test("tools added on a mode switch", () => {
    const extra = [...TOOLS, { name: "web_fetch", description: "x", input_schema: {} }, { name: "todo", description: "y", input_schema: {} }]
    const change = comparePrefix(view(body(history)), view(body(history, { tools: extra })))
    expect(change?.cause).toBe("tools_changed")
    expect(change?.summary).toBe("tool list changed (+2 tools: 3 → 5)")
    expect(change?.detail).toMatchObject({ added: ["web_fetch", "todo"], removed: [] })
    expect(change?.block_index).toBe(3)
  })

  test("tools removed", () => {
    const change = comparePrefix(view(body(history)), view(body(history, { tools: TOOLS.slice(0, 1) })))
    expect(change?.summary).toBe("tool list changed (-2 tools: 3 → 1)")
    expect(change?.diff).toBe("- write_file\n- run_shell")
  })

  test("tools sorted differently (MCP connection order)", () => {
    const change = comparePrefix(view(body(history)), view(body(history, { tools: [TOOLS[2], TOOLS[0], TOOLS[1]] })))
    expect(change?.cause).toBe("tools_reordered")
    expect(change?.region).toBe("tools")
    expect(change?.summary).toContain("same tools, different order")
  })

  test("a tool description edited", () => {
    const edited = TOOLS.map((tool) => (tool.name === "run_shell" ? { ...tool, description: "Now with a longer description." } : tool))
    const change = comparePrefix(view(body(history)), view(body(history, { tools: edited })))
    expect(change?.cause).toBe("tool_definition_changed")
    expect(change?.summary).toBe("tool definition changed: run_shell")
    expect(change?.diff).toContain("+ description: Now with a longer description.")
  })

  test("system prompt instructions refreshed", () => {
    const change = comparePrefix(view(body(history)), view(body(history, { system: `${SYSTEM}\nNew rule: always use tabs.` })))
    expect(change?.cause).toBe("system_changed")
    expect(change?.region).toBe("system")
    expect(change?.diff).toContain("+   New rule: always use tabs.")
  })

  test("a timestamp in the system prompt", () => {
    const prev = view(body(history, { system: `${SYSTEM} Current time: 2026-01-01 10:41.` }))
    const next = view(body(history, { system: `${SYSTEM} Current time: 2026-01-01 10:42.` }))
    const change = comparePrefix(prev, next)
    expect(change?.cause).toBe("system_dynamic_value")
    expect(change?.summary).toContain("timestamp")
    expect(change?.summary).toContain("10:41 → 10:42")
  })

  test("a request id in the system prompt", () => {
    const prev = view(body(history, { system: `${SYSTEM} request=3f2a9c1e-0b7d-4c55-9a1e-6b2f0c7d8e91` }))
    const next = view(body(history, { system: `${SYSTEM} request=8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d` }))
    expect(comparePrefix(prev, next)?.summary).toContain("unique id")
  })

  test("a system part added", () => {
    const change = comparePrefix(
      view(body(history, { system: [{ type: "text", text: SYSTEM }] })),
      view(body(history, { system: [{ type: "text", text: SYSTEM }, { type: "text", text: "extra" }] })),
    )
    expect(change?.cause).toBe("system_changed")
    expect(change?.summary).toBe("system prompt changed (1 → 2 parts)")
  })

  test("cache-relevant params changed", () => {
    const change = comparePrefix(view(body(history, { thinking: { type: "adaptive" } })), view(body(history, { thinking: { type: "disabled" } })))
    expect(change?.cause).toBe("params_changed")
    expect(change?.summary).toBe("request parameters changed: thinking")
    expect(change?.diff).toContain("+ thinking.type: disabled")
  })

  test("params that do not reach the prompt are ignored", () => {
    expect(comparePrefix(view(body(history, { max_tokens: 10, temperature: 0 })), view(body(history, { max_tokens: 20 })))).toBeNull()
  })

  test("tools are reported before params and messages", () => {
    const change = comparePrefix(
      view(body(history)),
      view(body([user("other"), ...history.slice(1)], { tools: TOOLS.slice(1), thinking: { type: "adaptive" } })),
    )
    expect(change?.cause).toBe("tools_changed")
  })

  test("a tool output truncated on replay", () => {
    const rewritten = [...history.slice(0, 2), toolResult("t1", "[output truncated]"), history[3]]
    const change = comparePrefix(view(body(history)), view(body([...rewritten, user("next")])))
    expect(change?.cause).toBe("tool_output_rewritten")
    expect(change?.summary).toBe("tool output in message #3 truncated after it was sent (34 → 18 chars)")
    expect(change?.detail).toMatchObject({ message: 3, direction: "truncated" })
  })

  test("a tool output expanded on replay", () => {
    const rewritten = [...history.slice(0, 2), toolResult("t1", "file contents line 1\nline 2\nline 3\nline 4 appended later"), history[3]]
    expect(comparePrefix(view(body(history)), view(body(rewritten)))?.summary).toContain("expanded")
  })

  test("an OpenAI tool message rewritten", () => {
    const messages = (output: string) => [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: output },
    ]
    const prev = canonicalizeOpenAI({ model: "gpt-test", messages: messages("a long tool output") })
    const next = canonicalizeOpenAI({ model: "gpt-test", messages: messages("short") })
    expect(comparePrefix({ model: "gpt-test", blocks: prev.blocks }, { model: "gpt-test", blocks: next.blocks })?.cause).toBe("tool_output_rewritten")
  })

  test("thinking blocks dropped on replay", () => {
    const withThinking = { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "ok" }] }
    const without = { role: "assistant", content: [{ type: "text", text: "ok" }] }
    const change = comparePrefix(view(body([user("q"), withThinking])), view(body([user("q"), without, user("next")])))
    expect(change?.cause).toBe("thinking_rewritten")
  })

  test("an already-sent message rewritten", () => {
    const change = comparePrefix(view(body(history)), view(body([user("start, but reworded"), ...history.slice(1)])))
    expect(change?.cause).toBe("message_edited")
    expect(change?.summary).toBe("message #1 (user) was edited after it was sent")
    expect(change?.diff).toContain("- content[0].text: start")
    expect(change?.diff).toContain("+ content[0].text: start, but reworded")
  })

  test("a date injected into the first user message", () => {
    const change = comparePrefix(view(body([user("Today is 2026-01-01. Task: x"), ...history.slice(1)])), view(body([user("Today is 2026-01-02. Task: x"), ...history.slice(1)])))
    expect(change?.cause).toBe("message_dynamic_value")
    expect(change?.summary).toContain("2026-01-01 → 2026-01-02")
  })

  test("a message removed from history", () => {
    const change = comparePrefix(view(body(history)), view(body([history[0], history[2], history[3]])))
    expect(change?.cause).toBe("message_removed")
    expect(change?.summary).toBe("message #2 (assistant) removed from history")
  })

  test("a message inserted into history", () => {
    const change = comparePrefix(view(body(history)), view(body([history[0], user("injected note"), ...history.slice(1)])))
    expect(change?.cause).toBe("message_inserted")
  })

  test("messages reordered", () => {
    const a = [user("one"), assistant("two"), user("three"), assistant("four")]
    const change = comparePrefix(view(body(a)), view(body([a[0], a[2], a[1], a[3]])))
    expect(change?.cause).toBe("messages_reordered")
  })

  test("consecutive tool calls merged into one message", () => {
    const split = [user("go"), toolUse("t1", "read_file"), toolUse("t2", "run_shell")]
    const merged = [user("go"), { role: "assistant", content: [...toolUse("t1", "read_file").content, ...toolUse("t2", "run_shell").content] }]
    const change = comparePrefix(view(body(split)), view(body(merged)))
    expect(change?.cause).toBe("messages_merged")
    expect(CAUSE_GROUP[change!.cause]).toBe("reshaped steps")
  })

  test("one message split into two", () => {
    const merged = [user("go"), { role: "assistant", content: [...toolUse("t1", "read_file").content, ...toolUse("t2", "run_shell").content] }]
    const split = [user("go"), toolUse("t1", "read_file"), toolUse("t2", "run_shell")]
    expect(comparePrefix(view(body(merged)), view(body(split)))?.cause).toBe("messages_split")
  })

  test("history compacted into a summary", () => {
    const long = Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? user(`u${index}`) : assistant(`a${index}`)))
    const change = comparePrefix(view(body(long)), view(body([user("Summary of the conversation so far"), user("continue")])))
    expect(change?.cause).toBe("compaction")
    expect(change?.summary).toBe("history compacted (12 → 2 messages from message #1)")
  })

  test("a harness compaction hint names compaction even when the shape is ambiguous", () => {
    const change = comparePrefix(view(body(history)), view(body([user("summary"), ...history.slice(1)]), { hints: [{ kind: "compaction" }] }))
    expect(change?.cause).toBe("compaction")
  })

  test("history truncated at the end", () => {
    const change = comparePrefix(view(body(history)), view(body(history.slice(0, 2))))
    expect(change?.cause).toBe("history_truncated")
  })

  test("hash-only (redacted) blocks still locate the change", () => {
    const strip = (comparable: Comparable): Comparable => ({
      ...comparable,
      blocks: comparable.blocks.map(({ content, ...rest }) => rest),
    })
    const change = comparePrefix(strip(view(body(history))), strip(view(body([user("other"), ...history.slice(1)]))))
    expect(change?.cause).toBe("message_edited")
    expect(change?.summary).toContain("content not recorded")
    expect(change?.diff).toBeUndefined()
  })

  test("every cause has a group", () => {
    for (const group of Object.values(CAUSE_GROUP)) expect(typeof group).toBe("string")
  })
})
