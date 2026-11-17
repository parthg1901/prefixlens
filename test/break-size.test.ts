// The size of a prefix break in the assertion path: estimated tokens re-read and still matching,
// and the extra cost of the re-read when the model has a price.

import Anthropic from "@anthropic-ai/sdk"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertPrefixStable, explainPrefixDiff, PrefixBreakError } from "../src/assert.ts"
import { readTableSync, sizeLine } from "../src/break-size.ts"
import { canonicalizeRequest, type Provider } from "../src/canonical.ts"
import { CHARS_PER_TOKEN } from "../src/estimate.ts"
import { findPrice, loadPricing, parsePricing } from "../src/pricing.ts"
import { recordRequests } from "../src/session.ts"
import { assistant, TOOLS, user } from "./helpers.ts"

const TABLE = parsePricing({
  models: [
    { provider: "anthropic", names: ["claude-synthetic-1"], input: 4, cache_read: 0.4, cache_write: 5, output: 20 },
    { provider: "openai", names: ["gpt-synthetic-1"], input: 2, cache_read: 0.2, output: 8 },
  ],
})

const HANDBOOK = "Follow the synthetic handbook. ".repeat(400)
const history = [user("Fix the synthetic bug. ".repeat(200)), assistant("Reading it now."), user("Go on.")]
const request = (time: string, overrides: Record<string, unknown> = {}) => ({
  model: "claude-synthetic-1",
  max_tokens: 1000,
  tools: TOOLS,
  system: [{ type: "text", text: HANDBOOK }, { type: "text", text: `Current time: 2026-01-01 ${time}.` }],
  messages: history,
  ...overrides,
})

/** The estimate, worked out here from the canonical blocks: four characters of each block's JSON content to a token. */
function tokens(body: Record<string, unknown>, from: number, to?: number, provider: Provider = "anthropic") {
  const chars = canonicalizeRequest(provider, body)
    .blocks.slice(from, to)
    .reduce((total, block) => total + JSON.stringify(block.content).length, 0)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function failure(prev: Record<string, unknown>, next: Record<string, unknown>, options = {}) {
  try {
    assertPrefixStable(prev, next, options)
  } catch (error) {
    expect(error).toBeInstanceOf(PrefixBreakError)
    return error as PrefixBreakError
  }
  throw new Error("expected assertPrefixStable to throw")
}

describe("the size of a break", () => {
  test("says about how many tokens are re-read and still match, and prices the re-read at the input price", () => {
    const prev = request("10:00")
    const error = failure(prev, request("10:01"), { pricing: TABLE })
    // Tools 1-3 and system part 1 match; system part 2 and the messages are re-read.
    const reread = tokens(prev, 4)
    expect(error.explanation.size).toEqual({ reread, matching: tokens(prev, 0, 4), cost: { extra: (reread * (4 - 0.4)) / 1e6, currency: "USD", model: "claude-synthetic-1" } })
    const lines = error.message.split("\n")
    const at = lines.findIndex((line) => line.startsWith("  first changed block: 5 of 8 (system part 2)"))
    expect(lines[at + 1]).toBe(
      "  size: about 1,200 tokens are re-read and about 3,200 still match (an estimate from the request text); at claude-synthetic-1 list prices that is about $0.0044 more than reading them from the cache, each time this happens",
    )
  })

  test("prices the part up to the request's last cache breakpoint at the cache-write price", () => {
    const marked = (time: string) =>
      request(time, { messages: [...history.slice(0, 2), { role: "user", content: [{ type: "text", text: "Go on.", cache_control: { type: "ephemeral" } }] }] })
    const size = explainPrefixDiff(marked("10:00"), marked("10:01"), { pricing: TABLE }).size!
    expect(size.cost!.extra).toBeCloseTo((size.reread * (5 - 0.4)) / 1e6, 12)
    // A breakpoint before the change leaves the re-read uncached input.
    const early = (time: string) => request(time, { system: [{ type: "text", text: HANDBOOK, cache_control: { type: "ephemeral" } }, { type: "text", text: `Current time: 2026-01-01 ${time}.` }] })
    const before = explainPrefixDiff(early("10:00"), early("10:01"), { pricing: TABLE }).size!
    expect(before.cost!.extra).toBeCloseTo((before.reread * (4 - 0.4)) / 1e6, 12)
  })

  test("gives tokens only for a model with no price, and with pricing: false", () => {
    const unpriced = failure(request("10:00", { model: "claude-unlisted-1" }), request("10:01", { model: "claude-unlisted-1" }), { pricing: TABLE })
    expect(unpriced.explanation.size).toEqual({ reread: tokens(request("10:00"), 4), matching: tokens(request("10:00"), 0, 4) })
    expect(unpriced.message).toContain("\n  size: about 1,200 tokens are re-read and about 3,200 still match (an estimate from the request text)\n")
    expect(unpriced.message).not.toContain("list prices")
    expect(explainPrefixDiff(request("10:00"), request("10:01"), { pricing: false }).size).not.toHaveProperty("cost")
  })

  test("prices a listed model from the bundled table by default", async () => {
    const bundled = await loadPricing(path.join(import.meta.dir, "..", "pricing.json"))
    const entry = findPrice(bundled, "anthropic", "claude-opus-5-5")!
    const opus = (time: string) => request(time, { model: "claude-opus-5-5" })
    const error = failure(opus("10:00"), opus("10:01"))
    const size = error.explanation.size!
    expect(size.cost).toEqual({ extra: (size.reread * (entry.input - entry.cache_read)) / 1e6, currency: "USD", model: "claude-opus-5-5" })
    expect(error.message).toMatch(/\n {2}size: about 1,200 tokens are re-read and about 3,200 still match \(an estimate from the request text\); at claude-opus-5-5 list prices that is about \$0\.\d+ more than reading them from the cache, each time this happens\n/)
  })

  test("a request shorter than the cache it breaks re-reads no more than it sends from the change on", () => {
    const prev = request("10:00")
    const compacted = request("10:00", { messages: [user("Summary: a bug was fixed."), assistant("Understood.")] })
    const size = explainPrefixDiff(prev, compacted, { pricing: false }).size!
    expect(size).toEqual({ reread: tokens(compacted, 5), matching: tokens(prev, 0, 5) })
    expect(size.reread).toBeLessThan(tokens(prev, 5))
  })

  test("a model change re-reads everything, priced as the new model", () => {
    const error = failure(request("10:00"), request("10:00", { model: "claude-unlisted-1" }), { pricing: TABLE })
    expect(error.explanation.size).toEqual({ reread: tokens(request("10:00"), 0), matching: 0 })
    expect(error.message).toContain("  the model changed, so nothing in the cache applies\n  size: about 4,400 tokens are re-read (an estimate from the request text)\n")
    const back = explainPrefixDiff(request("10:00", { model: "claude-unlisted-1" }), request("10:00"), { pricing: TABLE }).size!
    expect(back.cost?.model).toBe("claude-synthetic-1")
  })

  test("an allowed break keeps its message and carries the size", () => {
    const allowed = assertPrefixStable(request("10:00"), request("10:01"), { allowBreak: "settings_change", pricing: TABLE })
    expect(allowed.message).toBe("prefix changed at block 5, allowed (settings_change): system prompt changed: a timestamp value was updated (10:00 → 10:01)")
    expect(allowed.size).toMatchObject({ reread: tokens(request("10:00"), 4), cost: { model: "claude-synthetic-1" } })
  })

  test("a stable pair has no size", () => {
    const next = request("10:00", { messages: [...history, assistant("Done."), user("Thanks.")] })
    expect(assertPrefixStable(request("10:00"), next)).not.toHaveProperty("size")
  })

  test("item_reference items have no known size and are said not to be counted", () => {
    const responses = (instructions: string) => ({
      model: "gpt-synthetic-1",
      instructions: "You are a synthetic agent.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "One." }] }, { type: "item_reference", id: "msg_synthetic_1" }, { type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] }],
    })
    const error = failure(responses("Be brief."), responses("Be thorough."), { pricing: TABLE })
    expect(error.explanation.size).toMatchObject({ unsized: 1, reread: tokens(responses("Be brief."), 3, undefined, "openai") })
    expect(error.message).toContain("(an estimate from the request text; 1 block of unknown size not counted)")
  })

  test("a pricing file that is missing or not a table is no price, not an error", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prefixlens-size-"))
    try {
      writeFileSync(path.join(dir, "broken.json"), "{ not json")
      writeFileSync(path.join(dir, "empty.json"), "{}")
      expect(readTableSync(path.join(dir, "missing.json"))).toBeUndefined()
      expect(readTableSync(path.join(dir, "broken.json"))).toBeUndefined()
      expect(readTableSync(path.join(dir, "empty.json"))).toBeUndefined()
      expect(readTableSync(path.join(import.meta.dir, "..", "pricing.json"))?.models.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the size line", () => {
  test("rounds the estimate to two figures from 100 up, and the price to cents from a cent up", () => {
    const cost = (extra: number, currency = "USD") => ({ extra, currency, model: "claude-synthetic-1" })
    const tail = "more than reading them from the cache, each time this happens"
    expect(sizeLine({ reread: 18_237, matching: 1_337, cost: cost(0.0497) })).toBe(
      `size: about 18,000 tokens are re-read and about 1,300 still match (an estimate from the request text); at claude-synthetic-1 list prices that is about $0.05 ${tail}`,
    )
    expect(sizeLine({ reread: 14, matching: 0, unsized: 2, cost: cost(0.0000532) })).toBe(
      `size: about 14 tokens are re-read (an estimate from the request text; 2 blocks of unknown size not counted); at claude-synthetic-1 list prices that is about $0.000053 ${tail}`,
    )
    expect(sizeLine({ reread: 3, matching: 0, cost: cost(0.0000001) })).toContain("that is less than $0.000001 more")
    expect(sizeLine({ reread: 440, matching: 0, cost: cost(0.25, "EUR") })).toContain("that is about 0.25 EUR more")
    expect(sizeLine({ reread: 0, matching: 900 })).toBeUndefined()
  })
})

describe("the size of a break in a test session", () => {
  test("each break carries its size; the failure shows the first one's, and the list of further breaks is unchanged", async () => {
    const session = recordRequests()
    const client = new Anthropic({ apiKey: "sk-" + "synthetic", fetch: session.fetch, maxRetries: 0 })
    const messages: Anthropic.MessageParam[] = []
    for (const [index, question] of ["One.", "Two.", "Three."].entries()) {
      messages.push({ role: "user", content: question })
      const reply = await client.messages.create({ model: "claude-synthetic-1", max_tokens: 20, system: `${HANDBOOK} Turn ${index}.`, messages })
      messages.push({ role: "assistant", content: reply.content })
    }
    const steps = session.explain({ pricing: TABLE })
    expect(steps.map((step) => step.size?.matching)).toEqual([0, 0])
    expect(steps.every((step) => step.size!.reread > 3000 && step.size!.cost!.extra > 0)).toBe(true)
    const error = (() => {
      try {
        session.assertStable({ pricing: TABLE })
      } catch (thrown) {
        return thrown as PrefixBreakError
      }
    })()!
    const lines = error.message.split("\n")
    expect(lines[2]).toStartWith("  first changed block: 1 of 2 (system part 1)")
    expect(lines[3]).toMatch(/^ {2}size: about 3,\d00 tokens are re-read \(an estimate from the request text\); at claude-synthetic-1 list prices that is about \$0\.01 more than reading them from the cache, each time this happens$/)
    expect(lines.at(-1)).toBe("  1 more call changes the prefix: call 3 (system prompt changed (part 1 of 1 edited))")
  })
})
