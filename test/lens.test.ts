import Anthropic from "@anthropic-ai/sdk"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import OpenAI from "openai"
import prefixlens, { createLens, wrap } from "../src/index.ts"
import { parseTrace, type TraceRecord } from "../src/trace.ts"
import { startFakeUpstream, streamText } from "./fake-upstream.ts"

const SECRET = "sk-synthetic-SECRET-wrap-42"
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-lens-"))
const upstream = startFakeUpstream()
afterAll(() => {
  upstream.stop()
  rmSync(temp, { recursive: true, force: true })
})

const anthropicParams = {
  model: "claude-test-1",
  max_tokens: 100,
  system: [{ type: "text" as const, text: "You are a synthetic agent.", cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }],
  messages: [{ role: "user" as const, content: "Say something synthetic." }],
}

function collect() {
  const records: TraceRecord[] = []
  return { records, onRecord: (record: TraceRecord) => records.push(record) }
}

describe("wrap(client)", () => {
  test("Anthropic SDK: streamed and plain calls are recorded, results unchanged", async () => {
    const sink = collect()
    const trace = path.join(temp, "anthropic.trace.jsonl")
    const plain = new Anthropic({ apiKey: SECRET, baseURL: upstream.url, maxRetries: 0 })
    const client = wrap(new Anthropic({ apiKey: SECRET, baseURL: upstream.url, maxRetries: 0 }), { trace, onRecord: sink.onRecord })

    const events: string[] = []
    const stream = await client.messages.create({ ...anthropicParams, stream: true })
    for await (const event of stream) events.push(event.type)
    const plainEvents: string[] = []
    for await (const event of await plain.messages.create({ ...anthropicParams, stream: true })) plainEvents.push(event.type)
    expect(events).toEqual(plainEvents)

    const helper = await client.messages.stream(anthropicParams).finalMessage()
    expect(helper.content[0]).toMatchObject({ type: "text", text: "Synthetic answer." })
    const message = await client.messages.create(anthropicParams)
    expect(message).toEqual(await plain.messages.create(anthropicParams))
    const raw = await client.messages.create(anthropicParams).withResponse()
    expect(raw.response.headers.get("request-id")).toBe("req_synthetic")

    await Bun.sleep(20)
    expect(sink.records.length).toBe(4)
    expect(sink.records[0]).toMatchObject({ provider: "anthropic", model: "claude-test-1", cache_ttl_seconds: 3600, source: { recorder: "wrap" } })
    expect(sink.records[0]!.usage.cache_read_tokens).toBe(2048)
    expect(sink.records[2]!.usage).toEqual({ input_tokens: 5, cache_read_tokens: 3000, cache_write_tokens: 0, output_tokens: 4 })
    const text = readFileSync(trace, "utf8")
    expect(text).not.toContain(SECRET)
    expect(parseTrace(text).records.length).toBe(4)
  })

  test("OpenAI SDK: Responses and Chat Completions, streamed and plain", async () => {
    const sink = collect()
    const client = prefixlens.wrap(new OpenAI({ apiKey: SECRET, baseURL: `${upstream.url}/v1`, maxRetries: 0 }), { trace: false, onRecord: sink.onRecord })
    const input = [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "Hi." }] }]
    const deltas: string[] = []
    const stream = await client.responses.create({ model: "gpt-test-1", instructions: "Synthetic.", input, stream: true, store: false })
    for await (const event of stream) if (event.type === "response.output_text.delta") deltas.push(event.delta)
    expect(deltas).toEqual(["Synthetic answer."])
    const final = await client.responses.stream({ model: "gpt-test-1", instructions: "Synthetic.", input }).finalResponse()
    expect(final.id).toBe("resp_synthetic_01")
    const plain = await client.responses.create({ model: "gpt-test-1", instructions: "Synthetic.", input })
    expect(plain.output_text).toBe("Synthetic answer.")
    const chat = await client.chat.completions.create({ model: "gpt-test-1", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Hi." }] })
    for await (const _ of chat) {}
    await Bun.sleep(20)
    expect(sink.records.map((record) => [record.source?.api, record.usage.cache_read_tokens])).toEqual([
      ["openai-responses", 3072],
      ["openai-responses", 3072],
      ["openai-responses", 1792],
      ["openai-chat", 1920],
    ])
  })

  test("wrapping twice records once; a non-SDK object is refused", async () => {
    const sink = collect()
    const lens = createLens({ trace: false, onRecord: sink.onRecord })
    const client = lens.wrap(lens.wrap(new Anthropic({ apiKey: SECRET, baseURL: upstream.url, maxRetries: 0 })))
    await client.messages.create(anthropicParams)
    await Bun.sleep(20)
    expect(sink.records.length).toBe(1)
    expect(() => lens.wrap({ messages: {} })).toThrow(/expects an official Anthropic or OpenAI SDK client/)
  })
})

describe("lens.fetch and lens.observe", () => {
  test("lens.fetch records a custom client's streamed call", async () => {
    const sink = collect()
    const lens = createLens({ trace: false, onRecord: sink.onRecord })
    const recording = lens.fetch()
    const response = await recording(`${upstream.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "session-id": "synthetic-session" },
      body: JSON.stringify({ model: "gpt-test-1", stream: true, instructions: "Synthetic.", input: [] }),
    })
    expect(await response.text()).toBe(await streamText("/v1/responses"))
    await Bun.sleep(10)
    expect(sink.records[0]).toMatchObject({ headers: { "session-id": "synthetic-session" }, source: { recorder: "fetch" } })
  })

  test("observe takes a Responses body with its final event, SSE text or parsed events", async () => {
    const sink = collect()
    const lens = createLens({ trace: false, onRecord: sink.onRecord })
    const request = {
      model: "gpt-test-1",
      store: false,
      stream: true,
      instructions: "You are a synthetic agent.",
      tools: [{ type: "function", name: "read_file", description: "Synthetic.", parameters: { type: "object" }, strict: false }],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi." }] }],
    }
    const sse = await streamText("/v1/responses")
    const completed = { type: "response.completed", response: { id: "resp_x", model: "gpt-test-1", usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 3 } } }
    lens.observe({ request, response: completed, startedAt: "2026-01-01T10:00:00Z", headers: { "session-id": "s-1" } })
    lens.observe({ request, response: sse })
    lens.observe({ request, response: [{ type: "response.created", response: { id: "resp_y" } }, completed] })
    expect(sink.records.map((record) => record.usage.cache_read_tokens)).toEqual([1024, 3072, 1024])
    expect(sink.records[0]).toMatchObject({ ts: "2026-01-01T10:00:00.000Z", id: "resp_x", headers: { "session-id": "s-1" }, source: { recorder: "observe" } })
    expect(sink.records[0]!.request!.blocks.map((block) => `${block.kind}:${block.key ?? ""}`)).toEqual(["tool:read_file", "system:", "message:user"])
  })

  test("observe takes Anthropic and Chat Completions responses, and says when there is no usage", () => {
    const sink = collect()
    const skipped: string[] = []
    const lens = createLens({ trace: false, onRecord: sink.onRecord, onSkip: (reason) => skipped.push(reason) })
    lens.observe({ request: { ...anthropicParams }, response: { id: "msg_1", usage: { input_tokens: 3, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 2 } } })
    lens.observe({ request: { model: "gpt-test-1", messages: [{ role: "user", content: "Hi." }] }, response: { usage: { prompt_tokens: 50, completion_tokens: 2 } } })
    expect(lens.observe({ request: { model: "gpt-test-1", stream: true, messages: [] }, response: [] })).toBeUndefined()
    expect(sink.records.map((record) => record.provider)).toEqual(["anthropic", "openai"])
    expect(skipped[0]).toContain("stream_options.include_usage")
    expect(() => lens.observe({ request: "not a body" as unknown as Record<string, unknown>, response: {} })).toThrow(TypeError)
  })
})
