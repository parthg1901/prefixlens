// The Claude Code importer reads a log line by line and keeps message content in the file: these
// sessions are generated here (never committed) with digests computed the way Claude Code computes
// them, so every request must verify, whichever checkpoint its digest is resumed from.

import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { importClaudeCode } from "../src/adapters/claude-code.ts"
import { serializeTrace } from "../src/trace.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-cc-stream-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]))
      : value
const ccHash = (value: unknown) => createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex")

interface Options {
  segments: number
  turns: number
  size: (turn: number) => number
  /** Also mark the first message on every request, as Claude Code does on some versions. */
  markFirst?: boolean
  /** Request numbers (1-based) whose logged digest is of a different body. */
  tamper?: number[]
}

/** A synthetic session log: compactions start new request chains; each turn adds a tool result and a tool call. */
function session(file: string, options: Options) {
  const lines: unknown[] = []
  const tools = [{ name: "read_file", description: "Read a file.", input_schema: { type: "object" } }]
  const system = [{ type: "text", text: "You are a synthetic agent." }]
  const shapeHash = ccHash({ system, tools })
  lines.push({ type: "api-request-shape", shapeHash, shape: { system, tools } })
  let clock = Date.parse("2026-01-01T00:00:00Z")
  const ts = () => new Date((clock += 1000)).toISOString()
  let n = 0
  for (let segment = 0; segment < options.segments; segment++) {
    let messages: Record<string, unknown>[] = []
    let previous: string | undefined
    for (let turn = 0; turn < options.turns; turn++) {
      n++
      const text = `${"synthetic ".repeat(Math.ceil(options.size(n) / 10)).slice(0, options.size(n))}${n}`
      const user = turn === 0 ? { role: "user", content: [{ type: "text", text: `Summary ${segment}. ${text}` }] } : { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n - 1}`, content: text }] }
      lines.push({ type: "user", uuid: `u-${n}`, timestamp: ts(), message: user })
      const tail = turn === 0 ? [ccHash(user)] : [ccHash(messages.at(-1)), ccHash(user)]
      const keep = turn === 0 ? 0 : messages.length - 1
      messages = [...messages, user]
      const last = messages.length - 1
      const marks = [
        { path: ["system", 0], value: { type: "ephemeral" } },
        ...(options.markFirst && last > 0 ? [{ path: ["messages", 0, "content", 0], value: { type: "ephemeral" } }] : []),
        { path: ["messages", last, "content", 0], value: { type: "ephemeral" } },
      ]
      const params = { model: "claude-test-1", max_tokens: 1000 }
      const body: Record<string, unknown> = { ...params, system: structuredClone(system), tools, messages: structuredClone(messages) }
      for (const mark of marks) {
        let node = body as Record<string, unknown>
        for (const key of mark.path) node = node[key as string] as Record<string, unknown>
        node.cache_control = mark.value
      }
      const digest = options.tamper?.includes(n) ? ccHash({ ...body, max_tokens: 1 }) : ccHash(body)
      const id = `r-${n}`
      lines.push({ type: "api-request", id, ...(previous ? { base: previous } : {}), keep, tail, shapeHash, params, cacheControl: marks, querySource: "repl_main_thread", timestamp: ts(), requestDigest: digest })
      const content = [{ type: "tool_use", id: `toolu_${n}`, name: "read_file", input: { path: `${n}.txt` } }]
      lines.push({ type: "assistant", uuid: `a-${n}`, requestRef: id, timestamp: ts(), message: { id: `msg_${n}`, model: "claude-test-1", role: "assistant", content, usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 2000, output_tokens: 5 } } })
      messages = [...messages, { role: "assistant", content }]
      previous = id
    }
  }
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
}

describe("streaming the claude-code import", () => {
  test("every request of a long session verifies, with marks that move and a mark that stays on the first message", async () => {
    for (const markFirst of [false, true]) {
      const file = path.join(temp, `long-${markFirst}.jsonl`)
      session(file, { segments: 3, turns: 40, size: () => 300, markFirst })
      const result = await importClaudeCode(file, { subagents: false })
      expect(result.records).toHaveLength(120)
      expect(result.records.map((record) => record.source?.request)).toEqual(Array(120).fill("verified"))
      expect(result.warnings).toEqual([])
    }
  })

  test("a request whose digest does not match is imported usage-only, and the requests after it still verify", async () => {
    const file = path.join(temp, "tampered.jsonl")
    session(file, { segments: 1, turns: 12, size: () => 100, tamper: [5] })
    const result = await importClaudeCode(file, { subagents: false })
    expect(result.records.map((record) => record.source?.request)).toEqual([...Array(4).fill("verified"), "mismatch", ...Array(7).fill("verified")])
    expect(result.records[4]!.fidelity).toBe("usage-only")
  })

  test("a line longer than the read buffer is read whole", async () => {
    const file = path.join(temp, "big-line.jsonl")
    session(file, { segments: 1, turns: 4, size: (turn) => (turn === 2 ? 3_000_000 : 50) })
    const result = await importClaudeCode(file, { subagents: false })
    expect(result.records.map((record) => record.source?.request)).toEqual(Array(4).fill("verified"))
    const lengths = result.records[3]!.request!.blocks.map((block) => JSON.stringify(block.content ?? "").length)
    expect(Math.max(...lengths)).toBeGreaterThan(3_000_000)
  })

  test("with contentOnDemand the records list messages by hash, and the trace written with `content` is the same", async () => {
    const file = path.join(temp, "on-demand.jsonl")
    session(file, { segments: 2, turns: 10, size: () => 200, markFirst: true })
    const full = await importClaudeCode(file, { subagents: false })
    const lazy = await importClaudeCode(file, { subagents: false, contentOnDemand: true })
    expect(lazy.records.flatMap((record) => record.request!.blocks).filter((block) => block.kind === "message" && block.content !== undefined)).toEqual([])
    expect(serializeTrace(lazy.records, { content: lazy.content! })).toBe(serializeTrace(full.records))
    expect(serializeTrace(lazy.records, { compact: false, content: lazy.content! })).toBe(serializeTrace(full.records, { compact: false }))
  })
})
