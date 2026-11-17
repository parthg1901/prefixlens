// Steps in a test session: a test names what it is doing (`session.step("reload instructions")`), and
// failure messages, `explain()`, `summary()` and `allowBreakIn` speak in those names instead of call numbers.

import { describe, expect, test } from "bun:test"
import { assertSessionStable, PrefixBreakError, recordRequests, type RequestSession } from "../src/test.ts"
import { body, SYSTEM, TOOLS, user } from "./helpers.ts"

const URL = "https://api.anthropic.com/v1/messages"
const SEARCH = { name: "web_search", description: "Synthetic web_search tool.", input_schema: { type: "object" } }

/** A small synthetic harness: one history, sent in full on every call, with tools and a system prompt it can change. */
function harness(session: RequestSession) {
  const state = { tools: [...TOOLS] as unknown[], system: SYSTEM, messages: [] as unknown[] }
  const send = async (messages: unknown[]) => {
    const response = await session.fetch(URL, { method: "POST", body: JSON.stringify(body(messages, { tools: state.tools, system: state.system })) })
    return ((await response.json()) as { content: unknown[] }).content
  }
  return {
    state,
    async ask(text: string) {
      state.messages.push(user(text))
      state.messages.push({ role: "assistant", content: await send(state.messages) })
    },
    // A summariser call that extends the history, then the history replaced by its summary.
    async compact() {
      await send([...state.messages, user("Summarise the conversation.")])
      state.messages = [user("Summary: a bug was fixed."), { role: "assistant", content: [{ type: "text", text: "Understood." }] }]
    },
  }
}

/** The run of a test that covers six changes, one step each. `extra` adds a call to the first step. */
async function sixChanges(session: RequestSession, extra = false) {
  const agent = harness(session)
  session.step("first question")
  await agent.ask("Fix the bug.")
  await agent.ask("Go on.")
  if (extra) await agent.ask("And the other one.")
  session.step("queue a reminder")
  agent.state.messages.push(user("Reminder: run the tests."))
  await agent.ask("And then?")
  session.step("reload instructions")
  agent.state.system = `${SYSTEM} Updated.`
  await agent.ask("Next.")
  session.step("compaction")
  await agent.compact()
  await agent.ask("After.")
  session.step("add a tool")
  agent.state.tools.push(SEARCH)
  await agent.ask("Search.")
  session.step("remove the tool")
  agent.state.tools.pop()
  await agent.ask("Done.")
  return agent
}

function thrown(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected it to throw")
}

describe("steps", () => {
  test("each call belongs to the step last marked before it was made, and explain() names it", async () => {
    const session = recordRequests()
    await sixChanges(session)
    expect(session.requests.map((request) => [request.call, request.step])).toEqual([
      [1, "first question"],
      [2, "first question"],
      [3, "queue a reminder"],
      [4, "reload instructions"],
      [5, "compaction"],
      [6, "compaction"],
      [7, "add a tool"],
      [8, "remove the tool"],
    ])
    expect(session.explain().map((entry) => [entry.call, entry.step, entry.ok])).toEqual([
      [2, "first question", true],
      [3, "queue a reminder", true],
      [4, "reload instructions", false],
      [5, "compaction", true],
      [6, "compaction", false],
      [7, "add a tool", false],
      [8, "remove the tool", false],
    ])
  })

  test("a call made before the next step is marked stays in its own step", async () => {
    const session = recordRequests()
    session.step("one")
    const first = session.fetch(URL, { method: "POST", body: JSON.stringify(body([user("One.")])) })
    session.step("two")
    await first
    await session.fetch(URL, { method: "POST", body: JSON.stringify(body([user("One."), user("Two.")])) })
    expect(session.requests.map((request) => request.step)).toEqual(["one", "two"])
  })

  test("calls before the first step have no step", async () => {
    const session = recordRequests()
    const agent = harness(session)
    await agent.ask("One.")
    session.step("two")
    await agent.ask("Two.")
    expect(session.requests.map((request) => request.step)).toEqual([undefined, "two"])
    expect("step" in session.requests[0]!).toBe(false)
    expect(session.summary().steps.map((row) => [row.step, row.calls, row.status])).toEqual([
      [undefined, [1], "nothing to compare"],
      ["two", [2], "stable"],
    ])
  })

  test("a step needs a non-empty name", () => {
    const session = recordRequests()
    expect(() => session.step("")).toThrow(TypeError)
    expect(() => session.step("  ")).toThrow("session.step(name) takes the name of what the test does next")
    expect(() => session.step(7 as never)).toThrow("it was given 7")
  })
})

describe("failure messages", () => {
  test("name the step, and list every step that breaks after the first failure's full message", async () => {
    const session = recordRequests()
    await sixChanges(session)
    const error = thrown(() => session.assertStable({ allowBreakIn: { compaction: "compaction" } }))
    expect(error).toBeInstanceOf(PrefixBreakError)
    expect(error.message).toStartWith('prefix not stable at call 4 (step "reload instructions", lane main, compared with call 3): system prompt changed')
    expect(error.message).toContain('if this change is intentional, pass { allowBreakIn: { "reload instructions": { reason: "..." } } }')
    // The first failure in full (its diff and fix), then one line per step that breaks.
    const [full, list] = error.message.split("\n\n  3 of 6 steps break the prefix:\n\n")
    expect(full).toContain("fix: freeze the system prompt")
    expect(list).toBe(
      [
        "    step                 calls  result",
        "    reload instructions  4      break at call 4: system prompt changed (part 1 of 1 edited)",
        "    add a tool           7      break at call 7: tool list changed (+1 tool: 3 → 4)",
        "    remove the tool      8      break at call 8: tool list changed (-1 tool: 4 → 3)",
      ].join("\n"),
    )
    expect((error as PrefixBreakError).explanation).toMatchObject({ call: 4, step: "reload instructions", lane: "main" })
  })

  test("a session with no steps fails as before, naming calls only", async () => {
    const session = recordRequests()
    const agent = harness(session)
    await agent.ask("One.")
    agent.state.system = `${SYSTEM} Updated.`
    await agent.ask("Two.")
    agent.state.tools.push(SEARCH)
    await agent.ask("Three.")
    const message = thrown(() => session.assertStable()).message
    expect(message).toStartWith("prefix not stable at call 2 (lane main, compared with call 1): system prompt changed")
    expect(message).toEndWith("\n\n  1 more call changes the prefix: call 3 (tool list changed (+1 tool: 3 → 4))")
    expect(message).not.toContain("step")
    expect(session.explain().some((entry) => "step" in entry)).toBe(false)
  })

  test("a break in calls before the first step is named by its call, and listed under (no step)", async () => {
    const session = recordRequests()
    const agent = harness(session)
    await agent.ask("One.")
    agent.state.system = `${SYSTEM} Updated.`
    await agent.ask("Two.")
    session.step("add a tool")
    agent.state.tools.push(SEARCH)
    await agent.ask("Three.")
    const message = thrown(() => session.assertStable()).message
    expect(message).toStartWith("prefix not stable at call 2 (lane main, compared with call 1)")
    expect(message).toContain("if this change is intentional, pass { allowBreakAt: { 2: { reason: \"...\" } } }")
    expect(message).toContain("2 of 2 steps break the prefix:")
    expect(message).toContain("    (no step)   1-2    break at call 2: system prompt changed")
  })
})

describe("allowBreakIn", () => {
  test("allows the first change in the step, even after a call in it that kept the prefix", async () => {
    const session = recordRequests()
    await sixChanges(session)
    const allowed = { compaction: "compaction", "reload instructions": { after: "tools" as const, reason: "instructions reloaded" }, "add a tool": "tools changed", "remove the tool": "tools changed" }
    const entries = session.assertStable({ allowBreakIn: allowed })
    expect(entries.map((entry) => [entry.call, entry.allowed])).toEqual([
      [2, undefined],
      [3, undefined],
      [4, "instructions reloaded"],
      // The summariser call extends the history; the call after the compaction is the break.
      [5, undefined],
      [6, "compaction"],
      [7, "tools changed"],
      [8, "tools changed"],
    ])
  })

  test("survives a run that shifts by a call, where allowBreakAt does not", async () => {
    const options = { allowBreakIn: { compaction: "compaction", "reload instructions": "reload", "add a tool": "tools", "remove the tool": "tools" } }
    const shifted = recordRequests()
    await sixChanges(shifted, true)
    expect(shifted.assertStable(options)).toHaveLength(8)
    expect(() => shifted.assertStable({ allowBreakAt: { 4: "reload", 6: "compaction", 7: "tools", 8: "tools" } })).toThrow(/prefix not stable at call 5 \(step "reload instructions"/)
  })

  test("covers one break: a second change in the same step fails and says why", async () => {
    const session = recordRequests()
    const agent = harness(session)
    await agent.ask("One.")
    session.step("compaction")
    await agent.compact()
    await agent.ask("Two.")
    agent.state.tools.push(SEARCH)
    await agent.ask("Three.")
    const error = thrown(() => session.assertStable({ allowBreakIn: { compaction: "compaction" } }))
    expect(error.message).toStartWith('prefix not stable at call 4 (step "compaction", lane main, compared with call 3): tool list changed')
    expect(error.message).toContain('if this change is intentional, give it a step of its own: step "compaction" allows one break, and call 3 took it')
    expect(session.summary({ allowBreakIn: { compaction: "compaction" } }).steps.map((row) => row.result)).toEqual(["nothing to compare: the call is the first of its lane", "break at call 4: tool list changed (+1 tool: 3 → 4)"])
  })

  test("a change the allowance does not reach fails, and still takes the allowance", async () => {
    const session = recordRequests()
    const agent = harness(session)
    await agent.ask("One.")
    session.step("add a tool")
    agent.state.tools.push(SEARCH)
    await agent.ask("Two.")
    agent.state.system = `${SYSTEM} Updated.`
    await agent.ask("Three.")
    const error = thrown(() => session.assertStable({ allowBreakIn: { "add a tool": { after: "system", reason: "tool added" } } }))
    expect(error.message).toStartWith('prefix not stable at call 2 (step "add a tool"')
    expect(error.message).toContain("a break was allowed (tool added) only after block 4 (the tools and system prompt must stay), and this one is earlier")
    expect(error.message).toContain("1 of 2 steps breaks the prefix:")
    expect(error.message).toContain("break at call 2: tool list changed (+1 tool: 3 → 4); also at call 3")
    const later = session.explain({ allowBreakIn: { "add a tool": "tool added" } }).find((entry) => entry.call === 3)
    expect(later?.message).toContain('if this change is intentional, give it a step of its own: step "add a tool" allows one break, and call 2 took it')
  })

  test("every step of the name gets its own allowance; allowBreakAt for a call comes first", async () => {
    const session = recordRequests()
    const agent = harness(session)
    await agent.ask("One.")
    for (const round of [1, 2]) {
      session.step("compaction")
      await agent.compact()
      await agent.ask(`After ${round}.`)
      session.step("talk")
      await agent.ask(`More ${round}.`)
    }
    expect(session.assertStable({ allowBreakIn: { compaction: "compaction" } }).filter((entry) => entry.allowed).map((entry) => entry.call)).toEqual([3, 6])
    const first = session.explain({ allowBreakIn: { compaction: "compaction" }, allowBreakAt: { 3: "summary" } }).find((entry) => entry.call === 3)
    expect(first?.allowed).toBe("summary")
  })

  test("a name that is not a step, or a step with nothing to break, is an error", async () => {
    const plain = recordRequests()
    await harness(plain).ask("One.")
    expect(() => plain.explain({ allowBreakIn: { compaction: "compaction" } })).toThrow('allowBreakIn names step "compaction", but no step was marked (session.step(name) marks one)')
    const session = recordRequests()
    const agent = harness(session)
    session.step("first question")
    await agent.ask("One.")
    session.step("compaction")
    session.step("talk")
    await agent.ask("Two.")
    expect(() => session.assertStable({ allowBreakIn: { compactoin: "compaction" } })).toThrow('allowBreakIn names step "compactoin", but no step has that name (the steps: "first question", "compaction", "talk")')
    expect(() => session.assertStable({ allowBreakIn: { compaction: "compaction" } })).toThrow('allowBreakIn names step "compaction", but it recorded no call')
    expect(() => session.assertStable({ allowBreakIn: { "first question": "compaction" } })).toThrow('allowBreakIn names step "first question", but each call in it is the first of its lane')
  })
})

describe("summary", () => {
  test("one result per step, as data and as a table", async () => {
    const session = recordRequests()
    await sixChanges(session)
    const summary = session.summary({ allowBreakIn: { compaction: "compaction" } })
    expect(summary.steps.map((row) => [row.step, row.calls, row.status])).toEqual([
      ["first question", [1, 2], "stable"],
      ["queue a reminder", [3], "stable"],
      ["reload instructions", [4], "break"],
      ["compaction", [5, 6], "allowed"],
      ["add a tool", [7], "break"],
      ["remove the tool", [8], "break"],
    ])
    expect(summary.steps[3]!.explanations.map((entry) => entry.call)).toEqual([5, 6])
    expect(summary.text).toBe(
      [
        "step                 calls  result",
        "first question       1-2    stable",
        "queue a reminder     3      stable",
        "reload instructions  4      break at call 4: system prompt changed (part 1 of 1 edited)",
        "compaction           5-6    allowed at call 6 (compaction): history compacted (10 → 3 messages from message #1)",
        "add a tool           7      break at call 7: tool list changed (+1 tool: 3 → 4)",
        "remove the tool      8      break at call 8: tool list changed (-1 tool: 4 → 3)",
      ].join("\n"),
    )
  })

  test("a session with no steps is one row", async () => {
    const session = recordRequests()
    const agent = harness(session)
    await agent.ask("One.")
    await agent.ask("Two.")
    expect(session.summary().text).toBe("step       calls  result\n(no step)  1-2    stable")
  })

  test("a step that recorded no call is listed, and fails the assertion", async () => {
    const session = recordRequests()
    const agent = harness(session)
    session.step("first question")
    await agent.ask("One.")
    session.step("add a tool")
    agent.state.tools.push(SEARCH)
    session.step("second question")
    await agent.ask("Two.")
    expect(session.summary().steps.map((row) => [row.step, row.status, row.result])).toEqual([
      ["first question", "nothing to compare", "nothing to compare: the call is the first of its lane"],
      ["add a tool", "no calls", "no calls"],
      ["second question", "break", "break at call 2: tool list changed (+1 tool: 3 → 4)"],
    ])
    agent.state.tools.pop()
    const stable = recordRequests()
    const quiet = harness(stable)
    stable.step("one")
    await quiet.ask("One.")
    stable.step("nothing sent")
    stable.step("two")
    await quiet.ask("Two.")
    expect(() => stable.assertStable()).toThrow('prefixlens/test: step "nothing sent" recorded no call, so nothing in it was checked. A step holds the calls made after session.step() marks it')
  })

  test("calls not checked are listed by step", async () => {
    const session = recordRequests()
    session.step("start a thread")
    const first = await session.fetch(URL, { method: "POST", body: JSON.stringify(body([user("One.")], { thread: { type: "create" } })) })
    const id = ((await first.json()) as { id: string }).id
    session.step("continue it")
    await session.fetch(URL, { method: "POST", body: JSON.stringify({ model: "claude-test-1", max_tokens: 1000, messages: [user("Two.")], thread: { type: "continue", previous_message_id: id } }) })
    expect(session.summary().steps.map((row) => row.result)).toEqual(["nothing to compare: the call is the first of its lane", "not checked at call 2: it continues a conversation the provider keeps"])
    expect(() => session.assertStable()).toThrow('1 of the 2 calls was not checked (call 2, in step "continue it"): it continues a conversation the provider keeps')
  })
})

describe("assertSessionStable with steps", () => {
  const first = body([user("One.")])
  const second = body([user("One."), user("Two.")])
  const reloaded = body([user("One."), user("Two."), user("Three.")], { system: `${SYSTEM} Updated.` })

  test("steps say where each step begins; messages and allowBreakIn use them", () => {
    const steps = { 1: "first question", 3: "reload instructions" }
    expect(() => assertSessionStable([first, second, reloaded], { steps })).toThrow('prefix not stable at call 3 (step "reload instructions", lane main, compared with call 2)')
    const entries = assertSessionStable([first, second, reloaded], { steps, allowBreakIn: { "reload instructions": { after: "tools", reason: "reload" } } })
    expect(entries.map((entry) => [entry.call, entry.step, entry.allowed])).toEqual([
      [2, "first question", undefined],
      [3, "reload instructions", "reload"],
    ])
    // Without steps it is as before.
    expect(assertSessionStable([first, second]).map((entry) => "step" in entry)).toEqual([false])
  })

  test("steps must name calls that exist, with names", () => {
    expect(() => assertSessionStable([first, second], { steps: { 3: "late" } })).toThrow("assertSessionStable: steps names call 3, but there are 2 calls (numbered from 1)")
    expect(() => assertSessionStable([first, second], { steps: { 1: "" } })).toThrow("the step at call 1 has no name")
  })
})
