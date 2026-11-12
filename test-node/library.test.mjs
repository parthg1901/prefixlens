// The built library under Node, imported by package name as a consumer would ("prefixlens",
// "prefixlens/test" and "prefixlens/pricing.json" resolve to this checkout through its exports).

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { buildRecord, createLens, parseTrace, readResponse, serializeTrace, wrap } from "prefixlens"
import { assertPrefixStable, explainPrefixDiff, PrefixBreakError } from "prefixlens/test"
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
