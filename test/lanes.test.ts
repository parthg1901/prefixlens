import { describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { Recorder } from "../src/record/recorder.ts"
import { assistant, body, TOOLS, user } from "./helpers.ts"

const response = { id: "msg", usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }

// Each call ends before the next starts, like a sequential agent loop.
async function sequential(requests: Record<string, unknown>[]) {
  const recorder = new Recorder({ trace: false, name: "test" })
  const lanes: string[] = []
  for (const request of requests) lanes.push((await recorder.begin({ body: request, api: "anthropic-messages" })!.finish(response))!.lane!)
  return lanes
}

// Every call starts before any ends, like parallel subagents.
async function concurrent(requests: Record<string, unknown>[]) {
  const recorder = new Recorder({ trace: false, name: "test" })
  const pending = requests.map((request) => recorder.begin({ body: request, api: "anthropic-messages" })!)
  return (await Promise.all(pending.map((call) => call.finish(response)))).map((record) => record!.lane!)
}

describe("lane assignment", () => {
  test("a sequential conversation stays in one lane through a mode switch, an edit and a compaction", async () => {
    const first = [user("Fix the bug.")]
    const second = [...first, assistant("Looking."), user("Go on.")]
    expect(
      await sequential([
        body(first),
        body(second),
        body(second, { tools: TOOLS.slice(0, 1) }),
        body([user("Fix the bug!"), ...second.slice(1)], { tools: TOOLS.slice(0, 1) }),
        body([user("Summary of earlier work.")], { tools: TOOLS.slice(0, 1) }),
      ]),
    ).toEqual(["main", "main", "main", "main", "main"])
  })

  test("concurrent calls with different system prompts get their own lanes, even with the same first message", async () => {
    const task = [user("Same task.")]
    expect(
      await concurrent([body(task, { tools: [], system: "Agent one." }), body(task, { tools: [], system: "Agent two." }), body(task, { tools: [], system: "Agent three." })]),
    ).toEqual(["main", "lane-2", "lane-3"])
  })

  test("a side query with other tools and system prompt does not join the conversation", async () => {
    expect(await sequential([body([user("Fix the bug.")]), body([user("Fix the bug.")], { tools: [], system: "Write a title." })])).toEqual(["main", "lane-2"])
  })
})

// opencode sends x-opencode-session-id on every request (and x-opencode-parent-session-id from a subagent).
// Two `opencode run` sessions one after the other, same model, tools and instructions, through one proxy:
// before session headers were read, the second session's first call joined the first session's lane and
// was reported as "history compacted (7 → 1 messages)".
describe("harness session headers", () => {
  const chat = (messages: unknown[]) => ({ model: "gpt-test-1", stream: false, tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }], messages: [{ role: "system", content: "Synthetic opencode instructions." }, ...messages] })
  const chatUsage = (prompt: number, cached: number) => ({ id: "chatcmpl-synthetic", usage: { prompt_tokens: prompt, completion_tokens: 5, prompt_tokens_details: { cached_tokens: cached } } })
  const headers = (session: string, parent?: string) => new Headers({ "x-opencode-session-id": session, ...(parent ? { "x-opencode-parent-session-id": parent } : {}) })

  async function run(calls: { messages: unknown[]; prompt: number; cached: number; headers: Headers }[]) {
    const recorder = new Recorder({ trace: false, name: "test" })
    const records = []
    for (const [index, call] of calls.entries())
      records.push((await recorder.begin({ path: "/v1/chat/completions", body: JSON.stringify(chat(call.messages)), headers: call.headers, startedAt: new Date(Date.parse("2026-01-01T10:00:00Z") + index * 5000) })!.finish(chatUsage(call.prompt, call.cached)))!)
    return records
  }

  const first = [user("First task."), assistant("Working."), user("Go on."), assistant("Done."), user("Thanks."), assistant("Bye.")]

  test("a second session through the same proxy is a cold start in its own session, not a compaction of the first", async () => {
    const records = await run([
      { messages: first.slice(0, 1), prompt: 3000, cached: 0, headers: headers("ses_one") },
      { messages: first, prompt: 3400, cached: 2944, headers: headers("ses_one") },
      { messages: [user("Second task.")], prompt: 3000, cached: 0, headers: headers("ses_two") },
    ])
    expect(records.map((record) => [record.session, record.lane])).toEqual([
      ["ses_one", "main"],
      ["ses_one", "main"],
      ["ses_two", "main"],
    ])
    const turns = analyze(records, { pricing: { version: 1, currency: "USD", unit: "per_million_tokens", models: [] } }).turns
    expect(turns[2]!.status).toBe("cold")
    expect(turns[2]!.cause?.cause).toBe("cold_start")
  })

  test("a subagent's calls are a lane of its root session, named as the importer names them", async () => {
    const records = await run([
      { messages: first.slice(0, 1), prompt: 3000, cached: 0, headers: headers("ses_root") },
      { messages: [user("Subtask.")], prompt: 3000, cached: 0, headers: headers("ses_child", "ses_root") },
      { messages: [user("Subtask."), assistant("Found it."), user("More.")], prompt: 3100, cached: 2944, headers: headers("ses_child", "ses_root") },
      { messages: [user("Nested.")], prompt: 3000, cached: 0, headers: headers("ses_grandchild", "ses_child") },
    ])
    expect(records.map((record) => [record.session, record.lane])).toEqual([
      ["ses_root", "main"],
      ["ses_root", "subagent:ses_child"],
      ["ses_root", "subagent:ses_child"],
      ["ses_root", "subagent:ses_grandchild"],
    ])
  })

  test("x-prefixlens-session still wins over a harness's own header", async () => {
    const [record] = await run([{ messages: [user("Hi.")], prompt: 3000, cached: 0, headers: new Headers({ "x-opencode-session-id": "ses_one", "x-prefixlens-session": "chosen" }) }])
    expect(record!.session).toBe("chosen")
  })
})
