import { describe, expect, test } from "bun:test"
import { Recorder } from "../src/record/recorder.ts"
import { assistant, body, TOOLS, user } from "./helpers.ts"

const response = { id: "msg", usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }

// Each call ends before the next starts, like a sequential agent loop.
function sequential(requests: Record<string, unknown>[]) {
  const recorder = new Recorder({ trace: false, name: "test" })
  return requests.map((request) => recorder.begin({ body: request, api: "anthropic-messages" })!.finish(response)!.lane)
}

// Every call starts before any ends, like parallel subagents.
function concurrent(requests: Record<string, unknown>[]) {
  const recorder = new Recorder({ trace: false, name: "test" })
  return requests.map((request) => recorder.begin({ body: request, api: "anthropic-messages" })!).map((pending) => pending.finish(response)!.lane)
}

describe("lane assignment", () => {
  test("a sequential conversation stays in one lane through a mode switch, an edit and a compaction", () => {
    const first = [user("Fix the bug.")]
    const second = [...first, assistant("Looking."), user("Go on.")]
    expect(
      sequential([
        body(first),
        body(second),
        body(second, { tools: TOOLS.slice(0, 1) }),
        body([user("Fix the bug!"), ...second.slice(1)], { tools: TOOLS.slice(0, 1) }),
        body([user("Summary of earlier work.")], { tools: TOOLS.slice(0, 1) }),
      ]),
    ).toEqual(["main", "main", "main", "main", "main"])
  })

  test("concurrent calls with different system prompts get their own lanes, even with the same first message", () => {
    const task = [user("Same task.")]
    expect(
      concurrent([body(task, { tools: [], system: "Agent one." }), body(task, { tools: [], system: "Agent two." }), body(task, { tools: [], system: "Agent three." })]),
    ).toEqual(["main", "lane-2", "lane-3"])
  })

  test("a side query with other tools and system prompt does not join the conversation", () => {
    expect(sequential([body([user("Fix the bug.")]), body([user("Fix the bug.")], { tools: [], system: "Write a title." })])).toEqual(["main", "lane-2"])
  })
})
