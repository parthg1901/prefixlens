// What the recorders write and what they never write: the claims in SECURITY.md
// and the README's "Security and privacy" section, one test each.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildRecord, createLens, readResponse, wrap } from "../src/index.ts"
import { RECORDED_HEADERS } from "../src/record/exchange.ts"
import { startProxy } from "../src/proxy.ts"
import { parseTrace } from "../src/trace.ts"
import { startFakeUpstream } from "./fake-upstream.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-privacy-"))
const upstream = startFakeUpstream()
afterAll(() => {
  upstream.stop()
  rmSync(temp, { recursive: true, force: true })
})

// Every value is unique, so finding it anywhere in a trace file means it was written.
const SENSITIVE = {
  authorization: "Bearer sk-synthetic-privacy-authorization",
  "x-api-key": "sk-synthetic-privacy-x-api-key",
  "proxy-authorization": "Basic c3ludGhldGljLXByaXZhY3k=",
  cookie: "session=synthetic-privacy-cookie",
  "openai-organization": "org-synthetic-privacy-organization",
  "openai-project": "proj_synthetic_privacy_project",
  "chatgpt-account-id": "synthetic-privacy-account-id",
  "user-agent": "synthetic-privacy-user-agent/1.0",
  "x-stainless-os": "synthetic-privacy-os",
  "x-request-trace": "synthetic-privacy-custom-header",
}
const KEPT = {
  "session-id": "synthetic-privacy-session-id",
  "anthropic-beta": "synthetic-privacy-beta",
  "anthropic-version": "2023-06-01",
  "openai-beta": "synthetic-privacy-openai-beta",
}
const PROMPT = "Synthetic privacy prompt: refactor the private module."
const SYSTEM = "Synthetic privacy system prompt."
const TOOL = { name: "synthetic_privacy_tool", description: "Synthetic privacy tool description.", input_schema: { type: "object" } }
// Non-streamed so the fake upstream answers with its JSON body, whose text is "Synthetic answer.".
const body = { model: "claude-test-1", max_tokens: 100, tools: [TOOL], system: SYSTEM, messages: [{ role: "user", content: PROMPT }] }
const RESPONSE_TEXT = "Synthetic answer."

function expectNothingSensitive(text: string) {
  for (const [name, value] of Object.entries(SENSITIVE)) {
    expect(text).not.toContain(value)
    expect(text.toLowerCase()).not.toContain(`"${name}"`)
  }
}

describe("the recording proxy", () => {
  const trace = path.join(temp, "proxy.trace.jsonl")
  const proxy = startProxy({ provider: "anthropic", port: 0, upstream: upstream.url, trace })
  afterAll(() => proxy.stop())

  test("listens on 127.0.0.1 unless told otherwise", () => {
    expect(proxy.server.hostname).toBe("127.0.0.1")
    expect(proxy.url).toStartWith("http://127.0.0.1:")
  })

  test("forwards credentials upstream, writes only the four kept headers, and strips its own headers before forwarding", async () => {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...SENSITIVE, ...KEPT, "x-prefixlens-lane": "privacy", "x-prefixlens-session": "privacy-session" },
      body: JSON.stringify(body),
    })
    await response.text()
    await Bun.sleep(20)
    const seen = upstream.seen.at(-1)!
    expect(seen.headers["x-api-key"]).toBe(SENSITIVE["x-api-key"])
    expect(seen.headers.authorization).toBe(SENSITIVE.authorization)
    expect(seen.headers.cookie).toBe(SENSITIVE.cookie)
    expect(seen.headers["x-prefixlens-lane"]).toBeUndefined()
    expect(seen.headers["x-prefixlens-session"]).toBeUndefined()

    const text = readFileSync(trace, "utf8")
    expectNothingSensitive(text)
    const record = parseTrace(text).records.at(-1)!
    expect(Object.keys(record.headers ?? {}).sort()).toEqual([...RECORDED_HEADERS].sort())
    expect(record.headers).toEqual(KEPT)
    expect(record).toMatchObject({ lane: "privacy", session: "privacy-session" })
  })

  test("writes the request content in full: prompts, system prompt and tool definitions", () => {
    const text = readFileSync(trace, "utf8")
    expect(text).toContain(PROMPT)
    expect(text).toContain(SYSTEM)
    expect(text).toContain(TOOL.description)
  })

  test("writes the response's usage, id and model, not its content", () => {
    const text = readFileSync(trace, "utf8")
    expect(text).not.toContain(RESPONSE_TEXT)
    const record = parseTrace(text).records.at(-1)!
    expect(record).toMatchObject({ id: "msg_synthetic_json", model: "claude-test-1" })
    expect(record.usage).toMatchObject({ cache_read_tokens: 3000 })
  })

  test("writes nothing for error responses and calls that are not model calls", async () => {
    const before = readFileSync(trace, "utf8")
    const failed = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-status": "500", ...SENSITIVE },
      body: JSON.stringify({ ...body, messages: [{ role: "user", content: "Synthetic privacy failed prompt." }] }),
    })
    await failed.text()
    const other = await fetch(`${proxy.url}/v1/files`, { method: "POST", headers: SENSITIVE, body: "synthetic privacy upload" })
    await other.text()
    await Bun.sleep(20)
    expect(readFileSync(trace, "utf8")).toBe(before)
  })
})

describe("wrap, lens.fetch, lens.observe and buildRecord", () => {
  const init = () => ({ method: "POST", headers: { "content-type": "application/json", ...SENSITIVE, ...KEPT }, body: JSON.stringify(body) })

  test("wrap(client) sends credentials unchanged and writes only the kept headers", async () => {
    const trace = path.join(temp, "wrap.trace.jsonl")
    const client = wrap({ fetch: globalThis.fetch.bind(globalThis) }, { trace })
    await (await client.fetch(`${upstream.url}/v1/messages`, init())).text()
    await Bun.sleep(20)
    expect(upstream.seen.at(-1)!.headers["x-api-key"]).toBe(SENSITIVE["x-api-key"])
    const text = readFileSync(trace, "utf8")
    expectNothingSensitive(text)
    expect(text).not.toContain(RESPONSE_TEXT)
    expect(text).toContain(PROMPT)
    expect(parseTrace(text).records.at(-1)!.headers).toEqual(KEPT)
  })

  test("lens.fetch() writes only the kept headers, also from a Request object", async () => {
    const trace = path.join(temp, "fetch.trace.jsonl")
    const recording = createLens({ trace }).fetch()
    await (await recording(new Request(`${upstream.url}/v1/messages`, init()))).text()
    await Bun.sleep(20)
    const text = readFileSync(trace, "utf8")
    expectNothingSensitive(text)
    expect(parseTrace(text).records.at(-1)!.headers).toEqual(KEPT)
  })

  test("lens.observe and buildRecord keep only the four headers and never the response content", () => {
    const response = { id: "msg_privacy", model: "claude-test-1", content: [{ type: "text", text: RESPONSE_TEXT }], usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 2 } }
    const headers = { ...SENSITIVE, ...KEPT }
    const observed = createLens({ trace: false }).observe({ request: body, response, headers })!
    const built = buildRecord({ api: "anthropic-messages", body, response: readResponse("anthropic-messages", response), startedAt: Date.now(), headers })
    for (const record of [observed, built]) {
      const text = JSON.stringify(record)
      expectNothingSensitive(text)
      expect(text).not.toContain(RESPONSE_TEXT)
      expect(text).toContain(PROMPT)
      expect(typeof record === "string" ? undefined : record.headers).toEqual(KEPT)
    }
  })
})
