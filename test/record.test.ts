import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { analyze } from "../src/analyze.ts"
import { apiFromBody, readResponse, sseEvents } from "../src/record/exchange.ts"
import { startProxy } from "../src/proxy.ts"
import { parseTrace, type TraceRecord } from "../src/trace.ts"
import { startFakeUpstream, streamText } from "./fake-upstream.ts"
import { TEST_PRICING } from "./helpers.ts"

const SECRET = "sk-synthetic-SECRET-0123456789"
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-record-"))
const upstream = startFakeUpstream()
afterAll(() => {
  upstream.stop()
  rmSync(temp, { recursive: true, force: true })
})

const tools = ["read_file", "write_file"].map((name) => ({ name, description: `Synthetic ${name}.`, input_schema: { type: "object" } }))
const anthropicBody = (messages: unknown[], system = "You are a synthetic agent.") => ({
  model: "claude-test-1",
  max_tokens: 100,
  stream: true,
  tools,
  system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
  messages,
})
const user = (text: string) => ({ role: "user", content: text })

describe("reading responses", () => {
  test("SSE parsing skips comments and needs no [DONE]", async () => {
    const events = sseEvents(await streamText("/v1/responses"))
    expect(events.length).toBe(8)
    expect(sseEvents("data: [DONE]\n\n: keep-alive\n\n")).toEqual([])
    expect(sseEvents('data: {"a":\ndata: 1}\n\n')).toEqual([{ a: 1 }])
  })

  test("Anthropic streams merge message_start and message_delta usage", async () => {
    const summary = readResponse("anthropic-messages", await streamText("/v1/messages"))
    expect(summary).toMatchObject({ id: "msg_synthetic_01", model: "claude-test-1", complete: true })
    expect(summary.usage).toMatchObject({ input_tokens: 12, cache_creation_input_tokens: 1500, cache_read_input_tokens: 2048, output_tokens: 7 })
  })

  test("a cut-off Anthropic stream keeps the input usage from its first event", async () => {
    const text = await streamText("/v1/messages")
    const summary = readResponse("anthropic-messages", text.slice(0, text.indexOf("content_block_delta")))
    expect(summary.complete).toBe(false)
    expect(summary.usage).toMatchObject({ cache_read_input_tokens: 2048 })
  })

  test("Responses streams take usage from response.completed; Chat from the usage chunk", async () => {
    expect(readResponse("openai-responses", await streamText("/v1/responses")).usage).toMatchObject({ input_tokens: 3200, input_tokens_details: { cached_tokens: 3072 } })
    expect(readResponse("openai-chat", await streamText("/v1/chat/completions")).usage).toMatchObject({ prompt_tokens: 2100 })
    expect(readResponse("openai-responses", { type: "response.completed", response: { id: "r", usage: { input_tokens: 1 } } })).toMatchObject({ id: "r", complete: true })
  })

  test("request bodies are told apart by shape", () => {
    expect(apiFromBody({ model: "m", input: [], instructions: "x" })).toBe("openai-responses")
    expect(apiFromBody(anthropicBody([user("hi")]))).toBe("anthropic-messages")
    expect(apiFromBody({ model: "m", messages: [{ role: "system", content: "x" }, user("hi")] })).toBe("openai-chat")
  })
})

describe("buildRecord, the public record builder", () => {
  test("gives the same record lens.observe writes, from the same request and response", async () => {
    const { buildRecord, createLens, readResponse } = await import("../src/index.ts")
    const request = { model: "gpt-test-1", stream: true, instructions: "Synthetic.", tool_choice: "none", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi." }] }] }
    const response = { type: "response.completed", response: { id: "resp_1", model: "gpt-test-1", usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1920 }, output_tokens: 5 } } }
    const startedAt = "2026-01-01T10:00:00.000Z"
    const headers = { "session-id": "synthetic", authorization: "Bearer never-written" }
    const observed = createLens({ trace: false }).observe({ request, response, startedAt, headers })!
    const built = buildRecord({ api: "openai-responses", body: request, response: readResponse("openai-responses", response), startedAt: Date.parse(startedAt), headers, recorder: "observe" })
    expect(built).toEqual(observed)
    expect(JSON.stringify(built)).not.toContain("never-written")
    // Defaults: lane "main", recorder "library".
    const plain = buildRecord({ api: "openai-responses", body: request, response: readResponse("openai-responses", response), startedAt })
    expect(plain).toMatchObject({ lane: "main", source: { recorder: "library" } })
    expect(buildRecord({ api: "openai-responses", body: request, response: { complete: true }, startedAt })).toBe("the response had no usage")
  })
})

describe("recording proxy", () => {
  const trace = path.join(temp, "proxy.trace.jsonl")
  const records: TraceRecord[] = []
  const skipped: string[] = []
  let proxy: Awaited<ReturnType<typeof startProxy>>
  beforeAll(async () => {
    proxy = await startProxy({ provider: "anthropic", port: 0, upstream: upstream.url, trace, onRecord: (record) => records.push(record), onSkip: (reason) => skipped.push(reason) })
  })
  afterAll(() => proxy.stop())

  const send = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SECRET, authorization: `Bearer ${SECRET}`, "anthropic-version": "2023-06-01", ...headers },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  const settle = () => Bun.sleep(20)

  test("passes the stream through byte for byte and records the call", async () => {
    const response = await send(anthropicBody([user("Fix the synthetic bug.")]))
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(await response.text()).toBe(await streamText("/v1/messages"))
    await settle()
    const seen = upstream.seen.at(-1)!
    expect(seen.headers["x-api-key"]).toBe(SECRET)
    expect(JSON.parse(seen.body)).toEqual(anthropicBody([user("Fix the synthetic bug.")]))
    const record = records.at(-1)!
    expect(record).toMatchObject({ provider: "anthropic", model: "claude-test-1", fidelity: "full-request", lane: "main", cache_ttl_seconds: 300, headers: { "anthropic-version": "2023-06-01" } })
    expect(record.usage).toEqual({ input_tokens: 12, cache_read_tokens: 2048, cache_write_tokens: 1500, output_tokens: 7 })
    expect(record.request!.blocks.map((block) => block.kind)).toEqual(["tool", "tool", "system", "message"])
  })

  test("forwards each chunk as it arrives", async () => {
    const response = await send(anthropicBody([user("Hold the synthetic stream.")]), { "x-test-hold": "1" })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("message_start")
    upstream.release()
    while (!(await reader.read()).done) {}
    await settle()
  })

  test("a client that aborts mid-stream breaks neither the proxy nor the trace", async () => {
    const before = records.length
    const controller = new AbortController()
    const response = await send(anthropicBody([user("Abort the synthetic stream.")]), { "x-test-hold": "1" }, controller.signal)
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await reader.read().catch(() => undefined)
    upstream.release()
    await Bun.sleep(50)
    // The first event carried the input usage, so the call is recorded, marked as interrupted.
    expect(records.length).toBe(before + 1)
    expect(records.at(-1)!.interrupted).toBe(true)
    expect(records.at(-1)!.source).not.toHaveProperty("complete")
    const next = await send(anthropicBody([user("After the abort.")]))
    expect(await next.text()).toBe(await streamText("/v1/messages"))
    await settle()
    expect(records.length).toBe(before + 2)
  })

  test("concurrent independent conversations become separate, complete records in separate lanes", async () => {
    const before = records.length
    await Promise.all(
      ["alpha", "beta", "gamma"].map(async (name) => (await send(anthropicBody([user(`Task ${name}.`)], `You are synthetic subagent ${name}.`))).text()),
    )
    await settle()
    const added = records.slice(before)
    expect(added.length).toBe(3)
    expect(new Set(added.map((record) => record.lane)).size).toBe(3)
    expect(added.every((record) => record.usage.output_tokens === 7)).toBe(true)
  })

  test("a follow-up joins the lane it extends; the lane header overrides", async () => {
    const first = anthropicBody([user("Fix the synthetic bug.")])
    await (await send({ ...first, messages: [...first.messages, { role: "assistant", content: [{ type: "text", text: "Done." }] }, user("Thanks.")] })).text()
    await (await send(anthropicBody([user("Pinned.")], "Another synthetic agent."), { "x-prefixlens-lane": "pinned" })).text()
    await settle()
    expect(records.at(-2)!.lane).toBe("main")
    expect(records.at(-1)!.lane).toBe("pinned")
    expect(upstream.seen.at(-1)!.headers["x-prefixlens-lane"]).toBeUndefined()
  })

  test("error responses and other endpoints pass through unrecorded", async () => {
    const before = records.length
    const failed = await send(anthropicBody([user("Overloaded.")]), { "x-test-status": "529" })
    expect(failed.status).toBe(529)
    expect(((await failed.json()) as { error: { type: string } }).error.type).toBe("overloaded_error")
    const other = await fetch(`${proxy.url}/v1/models`, { headers: { "x-api-key": SECRET } })
    expect(other.status).toBe(404)
    await settle()
    expect(records.length).toBe(before)
    expect(skipped.some((reason) => reason.includes("upstream answered 529"))).toBe(true)
  })

  test("the trace parses, never contains credentials, and reports", () => {
    const text = readFileSync(trace, "utf8")
    expect(text).not.toContain(SECRET)
    expect(text.toLowerCase()).not.toContain("authorization")
    expect(text).not.toContain("x-api-key")
    const parsed = parseTrace(text)
    expect(parsed.errors).toEqual([])
    expect(parsed.records.length).toBe(records.length)
    const analysis = analyze(parsed.records, { pricing: TEST_PRICING })
    expect(analysis.summary.lanes).toContain("pinned")
  })
})

describe("recording proxy, OpenAI", () => {
  test("Responses and Chat Completions streams, with the session-id header kept as metadata", async () => {
    const trace = path.join(temp, "openai.trace.jsonl")
    const proxy = await startProxy({ provider: "openai", port: 0, upstream: upstream.url, trace })
    const body = { model: "gpt-test-1", store: false, stream: true, instructions: "You are a synthetic agent.", tools: [], input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi." }] }] }
    const headers = { "content-type": "application/json", authorization: `Bearer ${SECRET}`, "session-id": "synthetic-session-1", "chatgpt-account-id": "synthetic-account" }
    const responses = await fetch(`${proxy.url}/v1/responses`, { method: "POST", headers, body: JSON.stringify(body) })
    expect(await responses.text()).toBe(await streamText("/v1/responses"))
    const chat = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-test-1", stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: "Synthetic." }, { role: "user", content: "Hi." }] }),
    })
    expect(await chat.text()).toBe(await streamText("/v1/chat/completions"))
    await Bun.sleep(20)
    await proxy.stop()
    const text = readFileSync(trace, "utf8")
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("synthetic-account")
    const { records } = parseTrace(text)
    expect(records.map((record) => record.usage)).toEqual([
      { input_tokens: 128, cache_read_tokens: 3072, cache_write_tokens: null, output_tokens: 40, reasoning_tokens: 24 },
      { input_tokens: 180, cache_read_tokens: 1920, cache_write_tokens: null, output_tokens: 9, reasoning_tokens: 0 },
    ])
    expect(records[0]!.headers).toEqual({ "session-id": "synthetic-session-1" })
    expect(records[0]!.params).toEqual({ store: false })
    expect(records[0]!.request!.blocks.map((block) => block.kind)).toEqual(["system", "message"])
  })
})

describe("recording proxy, Codex on the ChatGPT sign-in flow", () => {
  // Shapes from Codex's Responses requests: tools arrive as an additional_tools input item whose id is
  // new in each conversation, the conversation id is sent as session-id, and client_metadata repeats
  // Codex's own header values.
  const codexBody = (conversation: string, turn: string, input: unknown[]) => ({
    model: "gpt-test-1",
    stream: true,
    store: false,
    prompt_cache_key: conversation,
    client_metadata: { session_id: conversation, turn_id: turn, "x-codex-installation-id": "synthetic-installation" },
    input: [
      { type: "additional_tools", id: `at_${conversation}`, role: "developer", tools: [{ type: "namespace", name: "functions", description: "", tools: [] }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Synthetic developer instructions." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic environment context." }] },
      ...input,
    ],
  })
  const say = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })

  test("a WebSocket handshake is answered 426 and never forwarded, so the client falls back to HTTP", async () => {
    const before = upstream.seen.length
    const proxy = await startProxy({ provider: "openai", port: 0, upstream: upstream.url, trace: path.join(temp, "ws.trace.jsonl") })
    const response = await fetch(`${proxy.url}/backend-api/codex/responses`, {
      headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "c3ludGhldGljLWtleS0wMDAwMA==", authorization: `Bearer ${SECRET}` },
    })
    expect(response.status).toBe(426)
    await response.text()
    await proxy.stop()
    expect(upstream.seen.length).toBe(before)
  })

  test("client_metadata is not recorded, and a new conversation opens its own lane instead of reading as a changed prefix", async () => {
    const trace = path.join(temp, "codex.trace.jsonl")
    const proxy = await startProxy({ provider: "openai", port: 0, upstream: upstream.url, trace })
    const send = async (conversation: string, turn: string, input: unknown[]) => {
      const response = await fetch(`${proxy.url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, "session-id": conversation },
        body: JSON.stringify(codexBody(conversation, turn, input)),
      })
      await response.text()
      await Bun.sleep(20)
    }
    await send("conv-a", "turn-1", [say("First task.")])
    await send("conv-a", "turn-2", [say("First task."), say("And then?")])
    await send("conv-b", "turn-1", [say("Second task.")])
    await send("conv-b", "turn-2", [say("Second task."), say("Go on.")])
    await proxy.stop()
    const text = readFileSync(trace, "utf8")
    expect(text).not.toContain("synthetic-installation")
    expect(text).not.toContain(SECRET)
    const { records } = parseTrace(text)
    expect(records.map((record) => [record.headers?.["session-id"], record.lane])).toEqual([
      ["conv-a", "main"],
      ["conv-a", "main"],
      ["conv-b", "lane-2"],
      ["conv-b", "lane-2"],
    ])
    expect(records[0]!.params).toEqual({ store: false, prompt_cache_key: "conv-a" })
  })
})

describe("compressed request bodies", () => {
  test("a zstd-encoded request is forwarded as is and recorded", async () => {
    const trace = path.join(temp, "zstd.trace.jsonl")
    const proxy = await startProxy({ provider: "openai", port: 0, upstream: upstream.url, trace })
    const body = JSON.stringify({ model: "gpt-test-1", stream: true, instructions: "Synthetic.", input: [] })
    const compressed = Bun.zstdCompressSync(Buffer.from(body))
    const response = await fetch(`${proxy.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "zstd" }, body: compressed })
    await response.text()
    await Bun.sleep(20)
    await proxy.stop()
    expect(upstream.seen.at(-1)!.body).toBe(body)
    expect(upstream.seen.at(-1)!.headers["content-encoding"]).toBe("zstd")
    const { records } = parseTrace(readFileSync(trace, "utf8"))
    expect(records.length).toBe(1)
    expect(records[0]!.model).toBe("gpt-test-1")
  })
})
