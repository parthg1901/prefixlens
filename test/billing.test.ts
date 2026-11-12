// How a call was billed, and which OpenAI writes had the 12-hour lifetime:
// two optional record facts (trace format 1.2) set only where the writer knows them.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { findAdapter } from "../src/adapters/index.ts"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { startProxy, upstreamBilling } from "../src/proxy.ts"
import { buildRecord, readResponse } from "../src/record/exchange.ts"
import { renderTerminal } from "../src/report/terminal.ts"
import { parseTrace, type TraceRecord } from "../src/trace.ts"
import { normalizeUsage } from "../src/usage.ts"
import { TEST_PRICING, usage, usageRecord } from "./helpers.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-billing-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
const pricing = parsePricing(TEST_PRICING)

describe("12-hour cache writes", () => {
  test("OpenAI's split by lifetime is read into cache_write_12h_tokens", () => {
    const details = (split?: Record<string, number>) => ({ input_tokens: 10_000, input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 8000, ...(split ? { cache_write_tokens_details: split } : {}) }, output_tokens: 1 })
    expect(normalizeUsage("openai", details({ ttl_30m_tokens: 3000, ttl_12h_tokens: 5000 }))).toMatchObject({ cache_write_tokens: 8000, cache_write_12h_tokens: 5000 })
    expect(normalizeUsage("openai", details({ ttl_30m_tokens: 8000, ttl_12h_tokens: 0 }))).not.toHaveProperty("cache_write_12h_tokens")
    expect(normalizeUsage("openai", details())).not.toHaveProperty("cache_write_12h_tokens")
  })

  test("the reader accepts the field and rejects a bad one", () => {
    const line = (value: unknown) => JSON.stringify({ v: 1, ts: "2026-01-01T10:00:00Z", provider: "openai", model: "m", fidelity: "usage-only", usage: { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 10, cache_write_12h_tokens: value, output_tokens: 0 } })
    expect(parseTrace(line(10)).errors).toEqual([])
    expect(parseTrace(line(-1)).errors[0]).toContain("cache_write_12h_tokens")
  })
})

describe("billing", () => {
  const body = { model: "gpt-test-1", instructions: "Synthetic.", input: "Hi." }
  const response = readResponse("openai-responses", { usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 } })

  test("buildRecord writes it only when given, and the reader checks it", () => {
    expect(buildRecord({ api: "openai-responses", body, response, startedAt: 0 })).not.toHaveProperty("billing")
    expect(buildRecord({ api: "openai-responses", body, response, startedAt: 0, billing: "subscription" })).toMatchObject({ billing: "subscription" })
    const line = JSON.stringify({ v: 1, ts: "2026-01-01T10:00:00Z", provider: "openai", model: "m", fidelity: "usage-only", billing: "free", usage: { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: null, output_tokens: 0 } })
    expect(parseTrace(line).errors[0]).toContain('billing must be "per_token" or "subscription"')
  })

  test("the proxy sets it for the ChatGPT backend and leaves it out for an API endpoint", async () => {
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ id: "r", usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 } }) })
    const records: TraceRecord[] = []
    const api = await startProxy({ provider: "openai", port: 0, upstream: `http://127.0.0.1:${upstream.port}`, trace: path.join(temp, "api.trace.jsonl"), onRecord: (record) => records.push(record) })
    await (await fetch(`${api.url}/v1/responses`, { method: "POST", body: JSON.stringify(body) })).text()
    await Bun.sleep(20)
    await api.stop()
    upstream.stop(true)
    expect(records[0]).not.toHaveProperty("billing")
    expect(upstreamBilling(new URL("https://chatgpt.com/backend-api/codex"))).toBe("subscription")
    for (const other of ["https://api.openai.com", "https://api.anthropic.com", "https://notchatgpt.com", "https://chatgpt.com.example"]) expect(upstreamBilling(new URL(other))).toBeUndefined()
  })

  test("the Codex importer sets it when the rollout shows a ChatGPT plan, and not otherwise", async () => {
    const write = (name: string, planType: string | null) => {
      const file = path.join(temp, `rollout-2026-01-01T10-00-00-${name}.jsonl`)
      const at = (seconds: number) => new Date(Date.parse("2026-01-01T10:00:00Z") + seconds * 1000).toISOString()
      writeFileSync(
        file,
        [
          { timestamp: at(0), type: "session_meta", payload: { id: name, session_id: name, model_provider: "openai" } },
          { timestamp: at(1), type: "turn_context", payload: { model: "gpt-test-1" } },
          { timestamp: at(2), type: "token_usage_record", payload: { response_id: "resp_1", session_id: name, thread_id: name, usage: { input_tokens: 2000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } } },
          { timestamp: at(2), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { limit_id: "codex", plan_type: planType } } },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      )
      return file
    }
    const codex = findAdapter("codex")!
    expect((await codex.import(write("00000000-0000-4000-8000-0000000b1110", "plus"), {})).records[0]!.billing).toBe("subscription")
    expect((await codex.import(write("00000000-0000-4000-8000-0000000b1111", null), {})).records[0]!).not.toHaveProperty("billing")
  })

  test("the report words its cost lines by it", () => {
    const records = (billing?: "per_token" | "subscription") => [usageRecord("claude-test-1", usage(10, 0, 2000)), usageRecord("claude-test-1", usage(10, 2000, 100))].map((record) => (billing ? { ...record, billing } : record))
    const notes = (list: TraceRecord[]) => analyze(list, { pricing, now: new Date("2026-01-02T00:00:00Z") }).summary.notes.join("\n")
    expect(notes(records("subscription"))).toContain("These calls were made on a subscription, which is not billed per token")
    expect(notes(records("per_token"))).toContain("Costs are at API list prices for per-token billing.")
    expect(notes(records())).toContain("Calls on a subscription (a Claude plan, ChatGPT sign-in, Codex) are not billed per token")
    expect(notes([...records("subscription").slice(0, 1), ...records().slice(1)])).toContain("1 of 2 calls were made on a subscription")
    const terminal = renderTerminal(analyze(records("subscription"), { pricing }))
    expect(terminal).toContain("at API list prices (subscription: a comparison, not billed)")
    expect(analyze(records("subscription"), { pricing }).summary.billing).toEqual({ per_token: 0, subscription: 2, unknown: 0 })
  })
})
