// The test session of "prefixlens/test", driven through the real Anthropic and OpenAI SDKs: every
// reply it gives, streamed or not, has to be parseable by the clients people use.

import Anthropic from "@anthropic-ai/sdk"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import OpenAI from "openai"
import { assertSessionStable, callTools, PrefixBreakError, recordRequests, type RequestSession } from "../src/test.ts"
import { parseTrace } from "../src/trace.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-session-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

// Never sent anywhere: session.fetch answers every call.
const KEY = "sk-" + "synthetic-session"
const anthropic = (session: RequestSession) => new Anthropic({ apiKey: KEY, fetch: session.fetch, maxRetries: 0 })
const openai = (session: RequestSession) => new OpenAI({ apiKey: KEY, fetch: session.fetch, maxRetries: 0 })

const WEATHER = { name: "get_weather", description: "Get the weather for a city.", input_schema: { type: "object" as const, properties: { city: { type: "string" } } } }
const LISBON = [{ name: "get_weather", args: { city: "Lisbon" } }]

describe("replies the Anthropic SDK reads", () => {
  const params = { model: "claude-test-1", max_tokens: 100, system: "You are a synthetic agent.", tools: [WEATHER], messages: [{ role: "user" as const, content: "Weather in Lisbon?" }] }

  test("messages.create: a text, then tool calls, as JSON", async () => {
    const session = recordRequests({ reply: (request) => (request.call === 1 ? "Sunny." : { text: "Checking.", toolCalls: LISBON }) })
    const client = anthropic(session)
    const text = await client.messages.create(params)
    expect(text).toMatchObject({ type: "message", role: "assistant", model: "claude-test-1", stop_reason: "end_turn", content: [{ type: "text", text: "Sunny." }] })
    expect(text.usage.input_tokens).toBeGreaterThan(20)
    expect(text.usage.output_tokens).toBeGreaterThan(0)
    const tools = await client.messages.create(params)
    expect(tools.stop_reason).toBe("tool_use")
    expect(tools.content).toMatchObject([{ type: "text", text: "Checking." }, { type: "tool_use", name: "get_weather", input: { city: "Lisbon" } }])
  })

  test("messages.create with stream: true, and messages.stream()", async () => {
    const session = recordRequests({ reply: callTools(LISBON) })
    const client = anthropic(session)
    const events: string[] = []
    for await (const event of await client.messages.create({ ...params, stream: true })) events.push(event.type)
    expect(events).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    const final = await client.messages.stream(params).finalMessage()
    expect(final.stop_reason).toBe("tool_use")
    expect(final.content).toMatchObject([{ type: "tool_use", name: "get_weather", input: { city: "Lisbon" } }])
    expect(final.usage.output_tokens).toBeGreaterThan(0)
    const spoken = await anthropic(recordRequests()).messages.stream(params).finalText()
    expect(spoken).toBe("OK.")
    expect(session.requests.map((request) => [request.call, request.format, request.lane, request.body.stream])).toEqual([
      [1, "anthropic-messages", "main", true],
      [2, "anthropic-messages", "main", true],
    ])
  })
})

describe("replies the OpenAI SDK reads", () => {
  const tools = [{ type: "function" as const, name: "get_weather", description: "Get the weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } } }, strict: false }]
  const input = [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "Weather in Lisbon?" }] }]
  const responses = { model: "gpt-test-1", instructions: "You are a synthetic agent.", tools, input }
  const chatTools = [{ type: "function" as const, function: { name: "get_weather", description: "Get the weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } } } } }]
  const chat = { model: "gpt-test-1", tools: chatTools, messages: [{ role: "system" as const, content: "You are a synthetic agent." }, { role: "user" as const, content: "Weather in Lisbon?" }] }

  test("responses.create: a text, then a tool call, as JSON", async () => {
    const session = recordRequests({ reply: (request) => (request.call === 1 ? "Sunny." : { toolCalls: LISBON }) })
    const client = openai(session)
    const text = await client.responses.create(responses)
    expect(text.output_text).toBe("Sunny.")
    expect(text.status).toBe("completed")
    expect(text.usage?.input_tokens).toBeGreaterThan(20)
    const called = await client.responses.create(responses)
    expect(called.output).toMatchObject([{ type: "function_call", name: "get_weather", arguments: '{"city":"Lisbon"}', status: "completed" }])
  })

  test("responses.create with stream: true, and responses.stream()", async () => {
    const session = recordRequests({ reply: (request) => (request.call === 1 ? "Sunny." : { text: "Checking.", toolCalls: LISBON }) })
    const client = openai(session)
    const deltas: string[] = []
    const types: string[] = []
    for await (const event of await client.responses.create({ ...responses, stream: true })) {
      types.push(event.type)
      if (event.type === "response.output_text.delta") deltas.push(event.delta)
    }
    expect(deltas).toEqual(["Sunny."])
    expect(types.at(0)).toBe("response.created")
    expect(types.at(-1)).toBe("response.completed")
    const final = await client.responses.stream(responses).finalResponse()
    expect(final.output_text).toBe("Checking.")
    expect(final.output).toMatchObject([{ type: "message" }, { type: "function_call", name: "get_weather", arguments: '{"city":"Lisbon"}' }])
    expect(session.requests.map((request) => request.format)).toEqual(["openai-responses", "openai-responses"])
  })

  test("chat.completions.create: a text, then a tool call, as JSON", async () => {
    const session = recordRequests({ reply: (request) => (request.call === 1 ? "Sunny." : { toolCalls: LISBON }) })
    const client = openai(session)
    const text = await client.chat.completions.create(chat)
    expect(text.choices[0]).toMatchObject({ finish_reason: "stop", message: { role: "assistant", content: "Sunny." } })
    expect(text.usage?.prompt_tokens).toBeGreaterThan(20)
    const called = await client.chat.completions.create(chat)
    expect(called.choices[0]).toMatchObject({ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ type: "function", function: { name: "get_weather", arguments: '{"city":"Lisbon"}' } }] } })
  })

  test("chat.completions.create with stream: true, and chat.completions.stream()", async () => {
    const session = recordRequests({ reply: (request) => (request.call === 3 ? { toolCalls: LISBON } : "Sunny.") })
    const client = openai(session)
    const texts: string[] = []
    const usages: unknown[] = []
    for await (const chunk of await client.chat.completions.create({ ...chat, stream: true, stream_options: { include_usage: true } })) {
      texts.push(chunk.choices[0]?.delta.content ?? "")
      if (chunk.usage) usages.push(chunk.usage)
    }
    expect(texts.join("")).toBe("Sunny.")
    expect(usages).toHaveLength(1)
    // Without stream_options.include_usage a real stream reports no usage; the call is recorded all the same.
    let chunks = 0
    for await (const chunk of await client.chat.completions.create({ ...chat, stream: true })) chunks += chunk.usage ? 100 : 1
    expect(chunks).toBe(3)
    const final = await client.chat.completions.stream(chat).finalChatCompletion()
    expect(final.choices[0]).toMatchObject({ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "get_weather", arguments: '{"city":"Lisbon"}' } }] } })
    expect(session.requests).toHaveLength(3)
    expect(session.requests.every((request) => request.format === "openai-chat" && request.lane === "main")).toBe(true)
  })
})

// A small agent loop on each SDK: it keeps one history, calls the tools the model asks for, and stops at a text.
async function anthropicAgent(session: RequestSession, prompts: string[], history: Anthropic.MessageParam[] = [], system = "You are a synthetic agent.") {
  const client = anthropic(session)
  for (const prompt of prompts) {
    history.push({ role: "user", content: prompt })
    for (;;) {
      const message = await client.messages.create({ model: "claude-test-1", max_tokens: 100, system, tools: [WEATHER], messages: history })
      history.push({ role: "assistant", content: message.content })
      const uses = message.content.filter((part) => part.type === "tool_use")
      if (uses.length === 0) break
      history.push({ role: "user", content: uses.map((use) => ({ type: "tool_result" as const, tool_use_id: use.id, content: "21 degrees" })) })
    }
  }
  return history
}

describe("a session around an agent loop", () => {
  test("Anthropic Messages: a tool loop over three questions keeps its prefix", async () => {
    const session = recordRequests({ reply: callTools(LISBON, "It is 21 degrees.") })
    const history = await anthropicAgent(session, ["Weather in Lisbon?", "And tomorrow?", "Thanks."])
    expect(history.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "It is 21 degrees." }] })
    // Two model calls per question: the tool call, then the answer.
    expect(session.requests).toHaveLength(6)
    const steps = session.assertStable()
    expect(steps.map((step) => [step.previous, step.call, step.lane, step.stable])).toEqual([
      [1, 2, "main", true],
      [2, 3, "main", true],
      [3, 4, "main", true],
      [4, 5, "main", true],
      [5, 6, "main", true],
    ])
  })

  test("OpenAI Responses, streamed: a tool loop keeps its prefix", async () => {
    const session = recordRequests({ reply: callTools(LISBON, "It is 21 degrees.") })
    const client = openai(session)
    const input: OpenAI.Responses.ResponseInput = []
    for (const prompt of ["Weather in Lisbon?", "And tomorrow?"]) {
      input.push({ role: "user", content: prompt })
      for (;;) {
        const response = await client.responses
          .stream({ model: "gpt-test-1", instructions: "You are a synthetic agent.", store: false, tools: [{ type: "function", name: "get_weather", parameters: { type: "object", properties: {} }, strict: false }], input })
          .finalResponse()
        // The SDK types output items more widely than input items; the API takes them back as they are.
        input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]))
        const calls = response.output.filter((item) => item.type === "function_call")
        if (calls.length === 0) break
        input.push(...calls.map((call) => ({ type: "function_call_output" as const, call_id: call.call_id, output: "21 degrees" })))
      }
    }
    expect(session.requests).toHaveLength(4)
    expect(session.assertStable()).toHaveLength(3)
  })

  test("OpenAI Chat Completions: a tool loop keeps its prefix", async () => {
    const session = recordRequests({ reply: callTools(LISBON, "It is 21 degrees.") })
    const client = openai(session)
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: "You are a synthetic agent." }]
    for (const prompt of ["Weather in Lisbon?", "And tomorrow?"]) {
      messages.push({ role: "user", content: prompt })
      for (;;) {
        const completion = await client.chat.completions.create({ model: "gpt-test-1", tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }], messages })
        const message = completion.choices[0]!.message
        messages.push(message)
        if (!message.tool_calls?.length) break
        messages.push(...message.tool_calls.map((call) => ({ role: "tool" as const, tool_call_id: call.id, content: "21 degrees" })))
      }
    }
    expect(session.requests).toHaveLength(4)
    expect(session.assertStable()).toHaveLength(3)
  })

  test("a side call between two steps gets its own lane and is not compared with them", async () => {
    const session = recordRequests()
    const client = anthropic(session)
    const history = await anthropicAgent(session, ["Weather in Lisbon?"])
    await client.messages.create({ model: "claude-test-1", max_tokens: 20, system: "Write a title for this conversation.", messages: [{ role: "user", content: "Weather in Lisbon?" }] })
    await anthropicAgent(session, ["And tomorrow?"], history)
    expect(session.requests.map((request) => request.lane)).toEqual(["main", "lane-2", "main"])
    expect(session.assertStable().map((step) => [step.previous, step.call])).toEqual([[1, 3]])
  })

  test("a rewritten history fails, naming the call, the lane and the call it is compared with", async () => {
    const session = recordRequests()
    const history = await anthropicAgent(session, ["One.", "Two.", "Three."])
    // The harness keeps a window of the last four messages: the start of history is gone.
    await anthropicAgent(session, ["Four."], history.slice(-4))
    const failure = (() => {
      try {
        session.assertStable()
      } catch (error) {
        return error
      }
    })()
    expect(failure).toBeInstanceOf(PrefixBreakError)
    const error = failure as PrefixBreakError
    expect(error.message).toStartWith("prefix not stable at call 4 (lane main, compared with call 3): 2 oldest messages removed from the start of history")
    expect(error.message).toContain('if this change is intentional, pass { allowBreakAt: { 4: { reason: "..." } } }')
    expect(error.explanation).toMatchObject({ call: 4, previous: 3, lane: "main", stable: false, ok: false, change: { cause: "oldest_messages_removed" } })
    expect(session.explain().map((step) => step.ok)).toEqual([true, true, false])
  })

  test("allowBreakAt allows a compaction at one call, and only there", async () => {
    const session = recordRequests()
    await anthropicAgent(session, ["One.", "Two.", "Three."])
    // The harness replaces its history with a summary, twice.
    const compacted = await anthropicAgent(session, ["Four."], [{ role: "user", content: "Summary: three numbers were said." }, { role: "assistant", content: "Understood." }])
    await anthropicAgent(session, ["Five."], compacted)
    await anthropicAgent(session, ["Six."], [{ role: "user", content: "Summary: five numbers were said." }, { role: "assistant", content: "Understood." }])
    expect(() => session.assertStable()).toThrow(/prefix not stable at call 4 [^]*1 more call changes the prefix: call 6 \(/)
    expect(() => session.assertStable({ allowBreakAt: { 4: "compaction" } })).toThrow(/prefix not stable at call 6 /)
    const steps = session.assertStable({ allowBreakAt: { 4: "compaction", 6: { after: "system", reason: "compaction" } } })
    expect(steps.map((step) => step.allowed)).toEqual([undefined, undefined, "compaction", undefined, "compaction"])
    expect(() => session.assertStable({ allowBreakAt: { 9: "compaction" } })).toThrow("allowBreakAt names call 9, but there are 6 calls (numbered from 1)")
    expect(() => session.assertStable({ allowBreakAt: { 1: "compaction" } })).toThrow('allowBreakAt names call 1, but it is the first call of its lane ("main")')
  })

  test("a request that changes its system prompt and the start of its history at once is still compared", async () => {
    const session = recordRequests()
    const history = await anthropicAgent(session, ["One.", "Two."])
    await anthropicAgent(session, ["Three."], history.slice(-2), "You are a synthetic agent. Memory: the user counts.")
    expect(session.requests.map((request) => request.lane)).toEqual(["main", "main", "main"])
    expect(() => session.assertStable()).toThrow(/prefix not stable at call 3 \(lane main, compared with call 2\): system prompt changed/)
  })

  test("the x-prefixlens-lane header names a conversation", async () => {
    const session = recordRequests()
    const named = (lane: string) => new Anthropic({ apiKey: KEY, fetch: session.fetch, maxRetries: 0, defaultHeaders: { "x-prefixlens-lane": lane } })
    const ask = (client: Anthropic, content: string) => client.messages.create({ model: "claude-test-1", max_tokens: 20, system: "You are a synthetic agent.", messages: [{ role: "user", content }] })
    await ask(named("thread-a"), "One.")
    await ask(named("thread-b"), "Uno.")
    expect(session.requests.map((request) => request.lane)).toEqual(["thread-a", "thread-b"])
  })
})

describe("what a session refuses", () => {
  test("a request in another format is answered with an error naming its URL, and fails the assertion", async () => {
    const session = recordRequests()
    const client = openai(session)
    const refused = await client.embeddings.create({ model: "embed-test-1", input: "Hello." }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(OpenAI.NotFoundError)
    expect((refused as Error).message).toContain("POST https://api.openai.com/v1/embeddings is not a request it can answer")
    await client.responses.create({ model: "gpt-test-1", input: "One." })
    await client.responses.create({ model: "gpt-test-1", input: [{ role: "user", content: "One." }, { role: "assistant", content: "OK." }, { role: "user", content: "Two." }] })
    expect(session.requests).toHaveLength(2)
    expect(() => session.assertStable()).toThrow(/POST https:\/\/api\.openai\.com\/v1\/embeddings is not a request it can answer\. session\.fetch answers POST requests to/)
    const raw = await session.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "not json" })
    expect(raw.status).toBe(404)
    expect(((await raw.json()) as { error: { message: string } }).error.message).toContain("(the body is not a JSON object)")
  })

  test("an assertion with nothing to check says so", async () => {
    const session = recordRequests()
    expect(() => session.assertStable()).toThrow("no request was recorded, so there is nothing to check. Give session.fetch to the model provider")
    await anthropic(session).messages.create({ model: "claude-test-1", max_tokens: 20, messages: [{ role: "user", content: "One." }] })
    expect(() => session.assertStable()).toThrow("nothing to compare: 1 request was recorded")
    expect(session.explain()).toEqual([])
  })

  test("a reply script that throws or returns nothing usable fails the call and the assertion", async () => {
    const thrown = recordRequests({
      reply: () => {
        throw new Error("no reply planned")
      },
    })
    const failure = await anthropic(thrown).messages.create({ model: "claude-test-1", max_tokens: 20, messages: [{ role: "user", content: "One." }] }).catch((error: unknown) => error)
    expect((failure as Error).message).toContain("the reply script threw on call 1: no reply planned")
    expect(() => thrown.assertStable()).toThrow("the reply script threw on call 1: no reply planned")
    const empty = recordRequests({ reply: () => ({}) })
    await anthropic(empty).messages.create({ model: "claude-test-1", max_tokens: 20, messages: [{ role: "user", content: "One." }] }).catch(() => undefined)
    expect(() => empty.assertStable()).toThrow("the reply script's answer to call 1 has neither text nor toolCalls")
  })
})

describe("the trace of a session", () => {
  test("writeTrace writes a private trace file with one full-request record per call", async () => {
    const session = recordRequests({ reply: callTools(LISBON) })
    await anthropicAgent(session, ["Weather in Lisbon?", "And tomorrow?"])
    const file = path.join(temp, "session.trace.jsonl")
    session.writeTrace(file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const parsed = parseTrace(readFileSync(file, "utf8"))
    expect(parsed.errors).toEqual([])
    expect(parsed.records.map((record) => [record.lane, record.fidelity, record.provider, record.source?.recorder, record.source?.api])).toEqual(
      Array.from({ length: 4 }, () => ["main", "full-request", "anthropic", "test", "anthropic-messages"]),
    )
    // Usage is an estimate from the size of the request, the same on every run.
    expect(parsed.records.map((record) => record.usage.input_tokens)).toEqual(session.requests.map((request) => Math.ceil(JSON.stringify(request.body).length / 4)))
    expect(readFileSync(file, "utf8")).not.toContain(KEY)
  })
})

describe("assertSessionStable", () => {
  const system = "You are a synthetic agent."
  const first = { model: "claude-test-1", max_tokens: 100, system, messages: [{ role: "user", content: "One." }] }
  const second = { ...first, messages: [...first.messages, { role: "assistant", content: "OK." }, { role: "user", content: "Two." }] }
  const title = { model: "claude-test-1", max_tokens: 20, system: "Write a title.", messages: [{ role: "user", content: "A title for: One." }] }

  test("bodies in the order they were sent: lanes are found, and each body is compared with the one before it in its lane", () => {
    const steps = assertSessionStable([first, title, second])
    expect(steps.map((step) => [step.previous, step.call, step.lane, step.appended])).toEqual([[1, 3, "main", 2]])
    const rewritten = { ...second, system: "You are a synthetic agent. It is 10:02." }
    expect(() => assertSessionStable([first, title, rewritten])).toThrow(/prefix not stable at call 3 \(lane main, compared with call 1\): system prompt changed/)
    expect(assertSessionStable([first, title, rewritten], { allowBreakAt: { 3: { after: "tools", reason: "instructions refreshed" } } })[0]).toMatchObject({ ok: true, allowed: "instructions refreshed" })
  })

  test("options carry through: ignoreParams and provider", () => {
    expect(() => assertSessionStable([first, { ...second, thinking: { type: "enabled", budget_tokens: 1024 } }])).toThrow(PrefixBreakError)
    expect(assertSessionStable([first, { ...second, thinking: { type: "enabled", budget_tokens: 1024 } }], { ignoreParams: ["thinking"] })).toHaveLength(1)
    const gemini = (texts: string[]) => ({ systemInstruction: { parts: [{ text: system }] }, contents: texts.map((text, index) => ({ role: index % 2 === 0 ? "user" : "model", parts: [{ text }] })) })
    expect(assertSessionStable([gemini(["One."]), gemini(["One.", "OK.", "Two."])], { provider: "gemini" })).toHaveLength(1)
  })

  test("nothing to check is an error", () => {
    expect(() => assertSessionStable([])).toThrow("no request bodies were given")
    expect(() => assertSessionStable([first])).toThrow("nothing to compare: 1 request was recorded")
    expect(() => assertSessionStable([first, title])).toThrow("nothing to compare: each of the 2 requests is the first of its lane")
    // A side query that repeats the first message word for word is still not the conversation.
    expect(() => assertSessionStable([first, { ...title, messages: first.messages }])).toThrow("nothing to compare: each of the 2 requests")
  })
})
