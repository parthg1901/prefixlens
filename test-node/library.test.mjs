// The built library under Node, imported by package name as a consumer would ("prefixlens",
// "prefixlens/test" and "prefixlens/pricing.json" resolve to this checkout through its exports).

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { analyze, buildRecord, classifyMisses, createLens, loadPricing, parseTrace, readResponse, serializeTrace, wrap } from "prefixlens"
import { assertPrefixStable, assertSessionStable, callTools, explainPrefixDiff, PrefixBreakError, recordRequests } from "prefixlens/test"
import pricing from "prefixlens/pricing.json" with { type: "json" }
import { streamText, tempDir } from "./helpers.mjs"

const tools = [
  { name: "read_file", description: "Read a file.", input_schema: { type: "object" } },
  { name: "write_file", description: "Write a file.", input_schema: { type: "object" } },
]
const first = { model: "claude-test-1", tools, system: "Synthetic.", messages: [{ role: "user", content: "Fix the bug." }] }

test("assertPrefixStable passes an extension and names a reordered tool list", () => {
  assertPrefixStable(first, { ...first, messages: [...first.messages, { role: "assistant", content: "Looking." }] })
  assert.throws(() => assertPrefixStable(first, { ...first, tools: tools.toReversed() }), (error) => error instanceof PrefixBreakError && /tool order changed/.test(error.message))
  assert.equal(explainPrefixDiff(first, { ...first, tools: tools.toReversed() }, { allowBreak: { after: "start", reason: "test" } }).ok, true)
})

test("recordRequests answers the Anthropic and OpenAI SDKs under Node, streamed and not, and asserts on a tool loop", async (t) => {
  const key = "sk-" + "synthetic-node"
  const session = recordRequests({ reply: callTools([{ name: "read_file", args: { path: "a.txt" } }], "Fixed.") })
  const client = new Anthropic({ apiKey: key, fetch: session.fetch, maxRetries: 0 })
  const messages = [{ role: "user", content: "Fix the bug." }]
  for (const streamed of [true, false]) {
    const request = { model: "claude-test-1", max_tokens: 100, system: "Synthetic.", tools, messages }
    const message = streamed ? await client.messages.stream(request).finalMessage() : await client.messages.create(request)
    messages.push({ role: "assistant", content: message.content })
    const uses = message.content.filter((part) => part.type === "tool_use")
    assert.equal(uses.length, streamed ? 1 : 0)
    messages.push(...(uses.length > 0 ? [{ role: "user", content: uses.map((use) => ({ type: "tool_result", tool_use_id: use.id, content: "contents" })) }] : []))
  }
  assert.deepEqual(messages.at(-1).content, [{ type: "text", text: "Fixed." }])
  assert.deepEqual(session.assertStable().map((step) => [step.previous, step.call, step.lane, step.stable]), [[1, 2, "main", true]])

  const other = recordRequests()
  const openai = new OpenAI({ apiKey: key, fetch: other.fetch, maxRetries: 0 })
  assert.equal((await openai.responses.stream({ model: "gpt-test-1", input: "One." }).finalResponse()).output_text, "OK.")
  assert.equal((await openai.responses.create({ model: "gpt-test-1", input: "One." })).output_text, "OK.")
  let text = ""
  for await (const chunk of await openai.chat.completions.create({ model: "gpt-test-1", stream: true, messages: [{ role: "user", content: "One." }] })) text += chunk.choices[0]?.delta.content ?? ""
  assert.equal(text, "OK.")
  assert.equal((await openai.chat.completions.create({ model: "gpt-test-1", messages: [{ role: "user", content: "One." }] })).choices[0].message.content, "OK.")
  assert.deepEqual(other.requests.map((request) => [request.call, request.format]), [[1, "openai-responses"], [2, "openai-responses"], [3, "openai-chat"], [4, "openai-chat"]])

  // The session's trace, and the same verdict from the library that `prefixlens check` prints.
  const trace = path.join(tempDir(t, "session"), "session.trace.jsonl")
  session.writeTrace(trace)
  const check = classifyMisses(analyze(parseTrace(readFileSync(trace, "utf8")).records, { pricing: await loadPricing() }))
  assert.equal(check.ok, true)
  assert.deepEqual(check.calls.map((call) => call.class), ["cold-start", "ok"])
})

test("assertSessionStable finds the lanes of request bodies and names the call that breaks", () => {
  const second = { ...first, messages: [...first.messages, { role: "assistant", content: "Looking." }, { role: "user", content: "Go on." }] }
  const title = { model: "claude-test-1", system: "Write a title.", messages: [{ role: "user", content: "A title for: Fix the bug." }] }
  assert.equal(assertSessionStable([first, title, second]).length, 1)
  assert.throws(() => assertSessionStable([first, title, { ...second, tools: tools.toReversed() }]), (error) => error instanceof PrefixBreakError && /^prefix not stable at call 3 \(lane main, compared with call 1\): tool order changed/.test(error.message))
})

test("wrap records a streamed call through the client's fetch, and passes every byte on", async (t) => {
  const dir = tempDir(t, "wrap")
  const trace = path.join(dir, "wrap.trace.jsonl")
  const sse = streamText("/v1/messages")
  const client = { fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }) }
  const records = []
  wrap(client, { trace, onRecord: (record) => records.push(record) })
  const response = await client.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ ...first, stream: true }) })
  assert.equal(await response.text(), sse)
  for (let turn = 0; turn < 50 && records.length === 0; turn++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(records.length, 1)
  assert.equal(parseTrace(readFileSync(trace, "utf8")).records[0].request.blocks.length, 4)
})

test("createLens().observe and buildRecord write the same record", () => {
  const lens = createLens({ trace: false })
  const response = { id: "msg_synthetic", usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 5 } }
  const startedAt = new Date("2026-01-01T10:00:00Z")
  const observed = lens.observe({ request: first, response, startedAt })
  const built = buildRecord({ api: "anthropic-messages", body: first, response: readResponse("anthropic-messages", response), startedAt, recorder: "observe" })
  assert.deepEqual(observed, built)
  assert.equal(parseTrace(serializeTrace([built])).records.length, 1)
})

test("the bundled pricing table is exported", () => {
  assert.ok(pricing.models.length > 10)
})
