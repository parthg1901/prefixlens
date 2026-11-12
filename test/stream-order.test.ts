// The recorders never hold back a byte: the client has the whole response,
// last chunk included, before any work on the record begins, and building a
// record yields to other work between blocks. These tests check order, not time.

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { canonicalizeRequest, canonicalizeRequestAsync } from "../src/canonical.ts"
import { wrap } from "../src/lens.ts"
import { observeBody } from "../src/record/fetch.ts"
import { startProxy } from "../src/proxy.ts"
import { startFakeUpstream, streamText } from "./fake-upstream.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-order-"))
const upstream = startFakeUpstream()
afterAll(() => {
  upstream.stop()
  rmSync(temp, { recursive: true, force: true })
})

const body = JSON.stringify({ model: "claude-test-1", max_tokens: 10, stream: true, system: "Synthetic.", messages: [{ role: "user", content: "Order test." }] })

// Blocks the event loop until another process creates `flag`, and says whether it did.
function waitForFlag(flag: string): boolean {
  const giveUp = Date.now() + 10_000
  while (!existsSync(flag) && Date.now() < giveUp) Bun.sleepSync(5)
  return existsSync(flag)
}

// A client in another process, so it can receive bytes while this process is blocked; it creates `flag` once it has `expected` whole.
async function clientInAnotherProcess(url: string, init: { method: string; body?: string }, expected: string, flag: string) {
  const script = `const response = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(init.method)}, headers: { "content-type": "application/json" }${init.body ? `, body: ${JSON.stringify(init.body)}` : ""} })
    const text = await response.text()
    if (new Bun.CryptoHasher("sha256").update(text).digest("hex") === ${JSON.stringify(new Bun.CryptoHasher("sha256").update(expected).digest("hex"))}) await Bun.write(${JSON.stringify(flag)}, "ok")`
  await Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" }).exited
}

describe("the last chunk", () => {
  test("observeBody calls onEnd only after a socket client can have every byte, the body's end included", async () => {
    const flag = path.join(temp, "observe-flag")
    const encoder = new TextEncoder()
    let verdict: boolean | undefined
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        const source = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("first\n"))
            await Bun.sleep(20)
            controller.enqueue(encoder.encode(`${"x".repeat(200_000)}\nlast\n`))
            controller.close()
          },
        })
        // onEnd holds the event loop: anything not yet on the socket when it starts cannot reach the client.
        return new Response(observeBody(source, () => (verdict = waitForFlag(flag)), { toSocket: true }))
      },
    })
    await clientInAnotherProcess(`http://127.0.0.1:${server.port}/`, { method: "GET" }, `first\n${"x".repeat(200_000)}\nlast\n`, flag)
    for (let turn = 0; turn < 200 && verdict === undefined; turn++) await Bun.sleep(10)
    server.stop(true)
    expect(verdict).toBe(true)
  }, 20_000)

  test("reaches a proxy client in another process before the record is built", async () => {
    const flag = path.join(temp, "client-has-everything")
    const expected = await streamText("/v1/messages")
    let verdict = "no record"
    const proxy = startProxy({
      provider: "anthropic",
      port: 0,
      upstream: upstream.url,
      trace: path.join(temp, "order.trace.jsonl"),
      // Holds the event loop until the client says it has the whole response. Had the proxy kept any
      // byte back until the record was built, the client could not get it while this runs.
      onRecord: () => {
        verdict = waitForFlag(flag) ? "client had every byte first" : "client was still waiting"
      },
    })
    await clientInAnotherProcess(`${proxy.url}/v1/messages`, { method: "POST", body }, expected, flag)
    for (let turn = 0; turn < 200 && verdict === "no record"; turn++) await Bun.sleep(10)
    proxy.stop()
    expect(existsSync(flag)).toBe(true)
    expect(verdict).toBe("client had every byte first")
  }, 20_000)

  test("reaches an in-process reader (wrap) before the record is built", async () => {
    const events: string[] = []
    const client = wrap({ fetch: globalThis.fetch.bind(globalThis) }, { trace: false, onRecord: () => events.push("record") })
    const response = await client.fetch(`${upstream.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body })
    const reader = response.body!.getReader()
    for (;;) if ((await reader.read()).done) break
    events.push("reader saw the end")
    for (let turn = 0; turn < 100 && events.length < 2; turn++) await Bun.sleep(5)
    expect(events).toEqual(["reader saw the end", "record"])
  })
})

describe("building a record", () => {
  const long = {
    model: "claude-test-1",
    tools: Array.from({ length: 50 }, (_, index) => ({ name: `tool_${index}`, description: "Synthetic.", input_schema: { type: "object" } })),
    system: "Synthetic.",
    messages: Array.from({ length: 400 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `Synthetic message ${index}.` })),
  }

  test("yields to other work between blocks, and gives the same blocks as the synchronous form", async () => {
    let turns = 0
    const tick = () => {
      turns++
      if (!done) setImmediate(tick)
    }
    let done = false
    setImmediate(tick)
    const canonical = await canonicalizeRequestAsync("anthropic", long)
    done = true
    expect(canonical).toEqual(canonicalizeRequest("anthropic", long))
    // Other work ran while the 451 blocks were hashed, not only after.
    expect(turns).toBeGreaterThan(100)
  })
})
