// The recording proxy on Node (node:http): streaming, records, and the ordering guarantee the Bun
// suite proves for Bun.serve (test/stream-order.test.ts): every byte, the last included, reaches the
// client before any work on the record starts.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { test } from "node:test"
import { startProxy } from "../dist/index.js"
import { observeBody } from "../dist/record/fetch.js"
import { serve } from "../dist/runtime/server.js"
import { runScript, sleepSync, startFakeUpstream, streamText, tempDir } from "./helpers.mjs"

const body = JSON.stringify({ model: "claude-test-1", max_tokens: 10, stream: true, system: "Synthetic.", messages: [{ role: "user", content: "Order test." }] })

// Holds the event loop until another process creates `flag`, and says whether it did.
function waitForFlag(flag) {
  const giveUp = Date.now() + 10_000
  while (!existsSync(flag) && Date.now() < giveUp) sleepSync(5)
  return existsSync(flag)
}

// A client in another process, so it can receive bytes while this one is blocked; it creates `flag` once it has `expected` whole.
function clientInAnotherProcess(url, init, expected, flag) {
  const digest = createHash("sha256").update(expected).digest("hex")
  return runScript(`import { createHash } from "node:crypto"
    import { writeFileSync } from "node:fs"
    const response = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(init.method)}, headers: { "content-type": "application/json" }${init.body ? `, body: ${JSON.stringify(init.body)}` : ""} })
    const text = await response.text()
    if (createHash("sha256").update(text).digest("hex") === ${JSON.stringify(digest)}) writeFileSync(${JSON.stringify(flag)}, "ok")`)
}

test("observeBody's onEnd runs only after a socket client can have every byte, the body's end included", { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t, "observe")
  const flag = path.join(dir, "flag")
  const encoder = new TextEncoder()
  let verdict
  const server = await serve({
    port: 0,
    hostname: "127.0.0.1",
    handle: async () => {
      const source = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("first\n"))
          await new Promise((resolve) => setTimeout(resolve, 20))
          controller.enqueue(encoder.encode(`${"x".repeat(200_000)}\nlast\n`))
          controller.close()
        },
      })
      // onEnd holds the event loop: anything not yet on the socket when it starts cannot reach the client.
      return new Response(observeBody(source, () => (verdict = waitForFlag(flag)), { toSocket: true }))
    },
  })
  await clientInAnotherProcess(`http://127.0.0.1:${server.port}/`, { method: "GET" }, `first\n${"x".repeat(200_000)}\nlast\n`, flag)
  for (let turn = 0; turn < 200 && verdict === undefined; turn++) await new Promise((resolve) => setTimeout(resolve, 10))
  await server.stop()
  assert.equal(verdict, true)
})

test("a proxy client in another process has the whole response before the record is built", { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t, "order")
  const upstream = await startFakeUpstream()
  t.after(() => upstream.stop())
  const flag = path.join(dir, "client-has-everything")
  let verdict = "no record"
  const proxy = await startProxy({
    provider: "anthropic",
    port: 0,
    upstream: upstream.url,
    trace: path.join(dir, "order.trace.jsonl"),
    onRecord: () => {
      verdict = waitForFlag(flag) ? "client had every byte first" : "client was still waiting"
    },
  })
  await clientInAnotherProcess(`${proxy.url}/v1/messages`, { method: "POST", body }, streamText("/v1/messages"), flag)
  for (let turn = 0; turn < 200 && verdict === "no record"; turn++) await new Promise((resolve) => setTimeout(resolve, 10))
  await proxy.stop()
  assert.equal(verdict, "client had every byte first")
})

test("the proxy streams through, forwards unchanged, records each API, and never writes credentials", { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t, "proxy")
  const upstream = await startFakeUpstream()
  t.after(() => upstream.stop())
  const trace = path.join(dir, "proxy.trace.jsonl")
  const records = []
  const proxy = await startProxy({ provider: "openai", port: 0, upstream: upstream.url, trace, onRecord: (record) => records.push(record) })
  t.after(() => proxy.stop())

  // The first event arrives while the upstream is still holding the rest back.
  const held = await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-test-hold": "1", "x-api-key": "sk-synthetic-node-secret" }, body })
  const reader = held.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /message_start/)
  upstream.release()
  let rest = first
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    rest += new TextDecoder().decode(next.value)
  }
  assert.equal(rest, streamText("/v1/messages"))

  const chat = JSON.stringify({ model: "gpt-test-1", stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: "Synthetic." }, { role: "user", content: "Hi." }] })
  assert.equal(await (await fetch(`${proxy.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: "Bearer sk-synthetic-node-secret" }, body: gzipSync(chat) })).text(), streamText("/v1/chat/completions"))
  const responses = JSON.stringify({ model: "gpt-test-1", stream: true, instructions: "Synthetic.", input: "Hi." })
  assert.equal(await (await fetch(`${proxy.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "session-id": "synthetic-session" }, body: responses })).text(), streamText("/v1/responses"))
  for (let turn = 0; turn < 100 && records.length < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 10))

  assert.deepEqual(records.map((record) => record.source.api), ["anthropic-messages", "openai-chat", "openai-responses"])
  assert.equal(upstream.seen[1].headers["content-encoding"], "gzip")
  assert.equal(upstream.seen[0].headers["x-api-key"], "sk-synthetic-node-secret")
  assert.deepEqual(records[2].headers, { "session-id": "synthetic-session" })
  const text = readFileSync(trace, "utf8")
  assert.equal(text.trim().split("\n").length, 3)
  assert.doesNotMatch(text, /sk-synthetic-node-secret/)
})

test("the proxy refuses a foreign Host and a browser Origin with 403", async (t) => {
  const dir = tempDir(t, "guard")
  const upstream = await startFakeUpstream()
  t.after(() => upstream.stop())
  const proxy = await startProxy({ provider: "anthropic", port: 0, upstream: upstream.url, trace: path.join(dir, "guard.trace.jsonl"), onSkip: () => {} })
  t.after(() => proxy.stop())
  assert.equal((await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { origin: "https://attacker.example" }, body })).status, 403)
  assert.equal(upstream.seen.length, 0)
})

test("the proxy answers 403 to a request without a Host header and keeps serving", async (t) => {
  const dir = tempDir(t, "no-host")
  const upstream = await startFakeUpstream()
  t.after(() => upstream.stop())
  const skipped = []
  const proxy = await startProxy({ provider: "anthropic", port: 0, upstream: upstream.url, trace: path.join(dir, "no-host.trace.jsonl"), onSkip: (reason) => skipped.push(reason) })
  t.after(() => proxy.stop())
  // A raw HTTP/1.0 request: no client library sends one without Host.
  const answer = await new Promise((resolve, reject) => {
    let text = ""
    const socket = net.connect(proxy.port, "127.0.0.1", () => {
      socket.write(["POST /v1/messages HTTP/1.0", "content-type: application/json", `content-length: ${Buffer.byteLength(body)}`, "", body].join("\r\n"))
    })
    socket.on("data", (chunk) => (text += chunk))
    socket.on("close", () => resolve(text))
    socket.on("error", reject)
  })
  assert.equal(Number(answer.split(" ")[1]), 403)
  assert.match(skipped.at(-1), /the Host header is missing/)
  assert.equal(upstream.seen.length, 0)
  assert.equal((await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 200)
})
