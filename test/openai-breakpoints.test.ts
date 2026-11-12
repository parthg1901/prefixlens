// OpenAI's explicit cache breakpoints (GPT-5.6 and later, Responses API): `prompt_cache_breakpoint` on
// message parts, `prompt_cache_options` on the request. Recorded as breakpoints, like Anthropic's
// cache_control, and used by the analysis in explicit-only mode.

import { describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { canonicalizeRequest } from "../src/canonical.ts"
import { comparePrefix } from "../src/diff.ts"
import { parsePricing } from "../src/pricing.ts"
import { buildRecord, readResponse } from "../src/record/exchange.ts"
import { TEST_PRICING } from "./helpers.ts"

const tools = [{ type: "function", name: "read_file", parameters: { type: "object" } }]
const text = (value: string, mark?: Record<string, unknown>) => ({ type: "input_text", text: value, ...(mark ? { prompt_cache_breakpoint: mark } : {}) })
const message = (value: string, mark?: Record<string, unknown>) => ({ type: "message", role: "user", content: [text(value, mark)] })
const request = (input: unknown[], options?: Record<string, unknown>) => ({ model: "gpt-test-1", instructions: "Synthetic.", tools, input, ...(options ? { prompt_cache_options: options } : {}) })
const explicit = { mode: "explicit" }

describe("canonicalizing explicit breakpoints", () => {
  test("a marker on a part leaves the block's hash unchanged and marks the block", () => {
    const plain = canonicalizeRequest("openai", request([message("Read a.txt."), message("And b.txt.")]))
    const marked = canonicalizeRequest("openai", request([message("Read a.txt.", { mode: "explicit" }), message("And b.txt.")], explicit))
    expect(marked.blocks.map((block) => block.hash)).toEqual(plain.blocks.map((block) => block.hash))
    expect(marked.blocks.map((block) => block.breakpoint ?? false)).toEqual([false, false, true, false])
    expect(JSON.stringify(marked.blocks)).not.toContain("prompt_cache_breakpoint")
  })

  test("a marker inside a function_call_output's output, and on a Chat Completions part, is a breakpoint too", () => {
    const output = { type: "function_call_output", call_id: "call_1", output: [text("a.txt: hello", { mode: "explicit", ttl: "12h" })] }
    const responses = canonicalizeRequest("openai", request([message("Read a.txt."), output], explicit))
    expect(responses.blocks.at(-1)!).toMatchObject({ breakpoint: true, content: { type: "function_call_output", output: [{ type: "input_text", text: "a.txt: hello" }] } })
    const chat = canonicalizeRequest("openai", { model: "gpt-test-1", messages: [{ role: "user", content: [{ type: "text", text: "Hi.", prompt_cache_breakpoint: { mode: "explicit" } }] }] })
    expect(chat.blocks[0]).toMatchObject({ breakpoint: true, content: { role: "user", content: [{ type: "text", text: "Hi." }] } })
  })

  test("a moved marker is not a changed message", () => {
    const before = canonicalizeRequest("openai", request([message("One.", explicit), message("Two.")], explicit))
    const after = canonicalizeRequest("openai", request([message("One."), message("Two.", explicit)], explicit))
    expect(comparePrefix({ provider: "openai", ...before }, { provider: "openai", ...after })).toBeNull()
  })
})

describe("recording explicit breakpoints", () => {
  const usage = { usage: { input_tokens: 4000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 3000 }, output_tokens: 5 } }
  const record = (body: Record<string, unknown>) => buildRecord({ api: "openai-responses", body, response: readResponse("openai-responses", usage), startedAt: "2026-11-12T10:00:00Z" })

  test("cache_ttl_seconds is the request's ttl, or in explicit mode the last breakpoint's own", () => {
    expect(record(request([message("Hi.")]))).not.toHaveProperty("cache_ttl_seconds")
    expect(record(request([message("Hi.")], { ttl: "12h" }))).toMatchObject({ cache_ttl_seconds: 43_200 })
    expect(record(request([message("Hi.", { mode: "explicit", ttl: "12h" })], { mode: "explicit", ttl: "30m" }))).toMatchObject({ cache_ttl_seconds: 43_200 })
    expect(record(request([message("Hi.", { mode: "explicit" })], { mode: "explicit", ttl: "12h" }))).toMatchObject({ cache_ttl_seconds: 43_200 })
    // In implicit mode the implicit breakpoint at the end is the last one, with the request's ttl.
    expect(record(request([message("Hi.", { mode: "explicit", ttl: "12h" })], { ttl: "30m" }))).toMatchObject({ cache_ttl_seconds: 1800 })
  })

  test("prompt_cache_options is kept in params and its changes (a new comparison_response_id each call) do not explain a miss", () => {
    const first = record(request([message("One.")], { mode: "implicit", comparison_response_id: "resp_1" }))
    const second = record(request([message("One.")], { mode: "implicit", comparison_response_id: "resp_2" }))
    expect(typeof first !== "string" && first.params).toMatchObject({ prompt_cache_options: { comparison_response_id: "resp_1" } })
    if (typeof first === "string" || typeof second === "string") throw new Error("no record")
    expect(comparePrefix({ ...first, blocks: first.request!.blocks }, { ...second, blocks: second.request!.blocks })).toBeNull()
  })
})

describe("analyzing explicit-only mode", () => {
  const pricing = parsePricing(TEST_PRICING)
  const call = (input: unknown[], options: Record<string, unknown> | undefined, read: number, write: number, prompt: number, ts: string) => {
    const built = buildRecord({
      api: "openai-responses",
      body: request(input, options),
      response: readResponse("openai-responses", { usage: { input_tokens: prompt, input_tokens_details: { cached_tokens: read, cache_write_tokens: write }, output_tokens: 5 } }),
      startedAt: ts,
    })
    if (typeof built === "string") throw new Error(built)
    return built
  }

  test("only what the previous call wrote up to its breakpoint is expected, and a change after that breakpoint does not explain a miss", () => {
    const history = [message("Long shared context.", explicit), message("First question.")]
    const records = [
      call(history, explicit, 0, 3000, 3200, "2026-11-12T10:00:00Z"),
      // The last message was rewritten, after the breakpoint: the cached 3,000 tokens still match, but the read missed.
      call([history[0], message("First question, edited.")], explicit, 0, 3000, 3200, "2026-11-12T10:00:10Z"),
    ]
    const turn = analyze(records, { pricing }).turns[1]!
    expect(turn.expected_cached_tokens).toBe(3000)
    expect(turn.status).toBe("miss")
    expect(turn.cause?.cause).toBe("provider_side")
    expect(turn.cause?.summary).toContain("after the previous call's last cache breakpoint")
  })

  test("explicit-only mode without breakpoints caches nothing, so the next call is not a miss", () => {
    const records = [call([message("One.")], explicit, 0, 0, 3200, "2026-11-12T10:00:00Z"), call([message("One."), message("Two.")], explicit, 0, 0, 3300, "2026-11-12T10:00:10Z")]
    expect(analyze(records, { pricing }).turns[1]!.status).toBe("uncached")
  })

  test("implicit mode still expects the whole previous prompt, breakpoints or not", () => {
    const records = [call([message("One.", explicit), message("Two.")], undefined, 0, 0, 3200, "2026-11-12T10:00:00Z"), call([message("One."), message("Two."), message("Three.")], undefined, 0, 0, 3300, "2026-11-12T10:00:10Z")]
    const turn = analyze(records, { pricing }).turns[1]!
    expect(turn.expected_cached_tokens).toBe(3200 - (3200 % 128))
    expect(turn.status).toBe("miss")
  })
})
