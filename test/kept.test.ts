// Conversations the provider keeps (Anthropic's `thread`, OpenAI's `previous_response_id` and
// `conversation`): a request that continues one carries only what is new, so it is not compared with
// the request before it, and nothing reports it as a cache break.

import { beforeEach, describe, expect, test } from "bun:test"
import { analyze, classifyMisses, parsePricing, type TraceRecord } from "../src/index.ts"
import { keptConversation } from "../src/kept.ts"
import { paramRule } from "../src/params.ts"
import { assertPrefixStable, assertSessionStable, explainPrefixDiff, PrefixBreakError, recordRequests, type RequestSession } from "../src/test.ts"
import { assistant, body, fullRecord, resetClock, TEST_PRICING, usage, user } from "./helpers.ts"

beforeEach(resetClock)

type Json = Record<string, unknown>

async function send(session: RequestSession, url: string, request: Json): Promise<string> {
  const response = await session.fetch(url, { method: "POST", body: JSON.stringify(request) })
  return ((await response.json()) as { id: string }).id
}
const messages = (session: RequestSession, request: Json) => send(session, "https://api.anthropic.com/v1/messages", request)
const responses = (session: RequestSession, request: Json) => send(session, "https://api.openai.com/v1/responses", request)

const m1 = [user("task")]
const m2 = [...m1, assistant("on it"), user("go on")]
const m3 = [...m2, assistant("more"), user("and then")]
/** What a harness sends to continue a thread: no tools, no system prompt, only the new messages. */
const continued = (reply: string, text: string): Json => ({ model: "claude-test-1", max_tokens: 1000, messages: [user(text)], thread: { type: "continue", previous_message_id: reply } })

describe("keptConversation", () => {
  test("names the field that continues a conversation; a request sent in full has none", () => {
    expect(keptConversation({ thread: { type: "continue", previous_message_id: "msg_1" } })).toEqual({ by: "Anthropic's `thread`", id: "msg_1" })
    expect(keptConversation({ previous_response_id: "resp_1" })).toEqual({ by: "OpenAI's `previous_response_id`", id: "resp_1" })
    expect(keptConversation({ conversation: "conv_1" })).toEqual({ by: "OpenAI's `conversation`", id: "conv_1" })
    expect(keptConversation({ conversation: { id: "conv_1" } })?.id).toBe("conv_1")
    for (const full of [{}, { thread: { type: "create" } }, { previous_response_id: null }, { conversation: null }, undefined]) expect(keptConversation(full)).toBeUndefined()
  })

  test("the fields themselves are not part of the cached prefix", () => {
    expect(paramRule("anthropic", "thread").effect).toBe("none")
    expect(paramRule("openai", "previous_response_id").effect).toBe("none")
    expect(paramRule("openai", "conversation").effect).toBe("none")
  })
})

describe("two requests", () => {
  const first = body(m1, { thread: { type: "create" } })

  test("a request that continues a thread is not checked, and an assertion on it does not pass", () => {
    const explanation = explainPrefixDiff(first, continued("msg_1", "go on"))
    expect(explanation).toMatchObject({ stable: false, ok: false, change: null })
    expect(explanation.notChecked).toContain("the later request continues a conversation the provider keeps (Anthropic's `thread`)")
    expect(explanation.message).toStartWith("not checked: ")
    const thrown = (() => {
      try {
        assertPrefixStable(first, continued("msg_1", "go on"))
      } catch (error) {
        return error as Error
      }
    })()
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(PrefixBreakError)
    expect(thrown!.message).toContain("Compare two requests that carry the conversation in full")
    expect(explainPrefixDiff(continued("msg_1", "go on"), body(m2)).notChecked).toContain("the earlier request")
  })

  test("starting a thread is a full request: it is compared as any other", () => {
    expect(assertPrefixStable(body(m1), body(m2, { thread: { type: "create" } })).stable).toBe(true)
    expect(() => assertPrefixStable(first, body(m2, { thread: { type: "create" }, system: "Another prompt." }))).toThrow(PrefixBreakError)
  })

  test("OpenAI Responses: previous_response_id", () => {
    const input = (text: string) => [{ type: "message", role: "user", content: [{ type: "input_text", text }] }]
    const explanation = explainPrefixDiff({ model: "gpt-test", instructions: "Be brief.", input: input("task") }, { model: "gpt-test", instructions: "Be brief.", input: input("go on"), previous_response_id: "resp_1" })
    expect(explanation.notChecked).toContain("OpenAI's `previous_response_id`")
  })
})

describe("a session", () => {
  test("continued calls stay in their lane, are listed as not checked, and assertStable says which", async () => {
    const session = recordRequests()
    let reply = await messages(session, body(m1, { thread: { type: "create" } }))
    for (const text of ["go on", "and then", "finish"]) reply = await messages(session, continued(reply, text))
    expect(session.requests.map((request) => request.lane)).toEqual(["main", "main", "main", "main"])
    expect(session.explain().map((entry) => [entry.call, entry.previous, entry.ok, entry.notChecked !== undefined])).toEqual([
      [2, 1, false, true],
      [3, 2, false, true],
      [4, 3, false, true],
    ])
    expect(session.explain()[0]!.message).toStartWith("call 2 not checked (lane main): ")
    expect(() => session.assertStable()).toThrow("3 of the 4 calls were not checked (calls 2-4): each continues a conversation the provider keeps (Anthropic's `thread`)")
    expect(() => session.assertStable()).not.toThrow(PrefixBreakError)
  })

  test("a request sent in full again is compared with the last one that was", async () => {
    const session = recordRequests()
    const reply = await messages(session, body(m1, { thread: { type: "create" } }))
    await messages(session, continued(reply, "go on"))
    await messages(session, body(m3, { thread: { type: "create" } }))
    expect(session.requests.map((request) => request.lane)).toEqual(["main", "main", "main"])
    expect(session.explain().map((entry) => [entry.call, entry.previous, entry.stable])).toEqual([
      [2, 1, false],
      [3, 1, true],
    ])

    const rewritten = recordRequests()
    const first = await messages(rewritten, body(m1, { thread: { type: "create" } }))
    await messages(rewritten, continued(first, "go on"))
    await messages(rewritten, body(m3, { thread: { type: "create" }, system: "Another prompt." }))
    // A real break is reported before the calls that could not be checked.
    expect(() => rewritten.assertStable()).toThrow(PrefixBreakError)
    expect(() => rewritten.assertStable()).toThrow("prefix not stable at call 3 (lane main, compared with call 1)")
  })

  test("OpenAI Responses: previous_response_id names the reply it continues", async () => {
    const session = recordRequests()
    const input = (text: string) => [{ type: "message", role: "user", content: [{ type: "input_text", text }] }]
    const shared = { model: "gpt-test", instructions: "Be brief." }
    const reply = await responses(session, { ...shared, input: input("task") })
    await responses(session, { ...shared, input: input("go on"), previous_response_id: reply })
    expect(session.requests.map((request) => request.lane)).toEqual(["main", "main"])
    expect(() => session.assertStable()).toThrow("1 of the 2 calls was not checked (call 2): it continues a conversation the provider keeps (OpenAI's `previous_response_id`)")
  })

  test("without the provider keeping it, the same conversation is checked and passes", async () => {
    const session = recordRequests()
    for (const sent of [m1, m2, m3]) await messages(session, body(sent))
    expect(session.assertStable().map((entry) => entry.stable)).toEqual([true, true])
  })
})

describe("assertSessionStable", () => {
  test("request bodies that continue a thread are not checked", () => {
    const bodies = [body(m1, { thread: { type: "create" } }), continued("msg_1", "go on"), continued("msg_2", "and then")]
    expect(() => assertSessionStable(bodies)).toThrow("2 of the 3 calls were not checked (calls 2-3)")
    expect(assertSessionStable([body(m1), body(m2), body(m3)]).length).toBe(2)
  })
})

describe("a trace", () => {
  const pricing = parsePricing(TEST_PRICING)
  const record = (request: Json, cached: number, written: number, id: string): TraceRecord => fullRecord(request as never, usage(10, cached, written), { id })

  test("continued calls are judged by usage alone: a hit passes, a miss is unexplained, and neither is an avoidable break", () => {
    const records = [
      record(body(m1, { thread: { type: "create" } }), 0, 5000, "msg_1"),
      record(continued("msg_1", "go on"), 5000, 300, "msg_2"),
      record(continued("msg_2", "and then"), 0, 5600, "msg_3"),
    ]
    const analysis = analyze(records, { pricing })
    expect(analysis.turns.map((turn) => [turn.status, turn.not_compared !== undefined, turn.prefix_change])).toEqual([
      ["cold", false, undefined],
      ["hit", true, undefined],
      ["miss", true, undefined],
    ])
    expect(analysis.turns[2]!.cause?.summary).toContain("the provider keeps the conversation")
    expect(analysis.summary.notes.join("\n")).toContain("2 of 3 calls were not compared with the call before them")
    const check = classifyMisses(analysis)
    expect(check.calls.map((call) => call.class)).toEqual(["cold-start", "ok", "unexplained"])
    expect(check.ok).toBe(true)
    expect(check.calls[1]!.summary).toContain("the request was not compared")
    expect(check.calls[2]!.fix).toContain("record a run that sends the conversation in full")
  })
})
