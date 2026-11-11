import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { importClaudeCode } from "../src/adapters/claude-code.ts"
import { findAdapter } from "../src/adapters/index.ts"
import { importOpencode, listOpencodeSessions, providerFamily } from "../src/adapters/opencode.ts"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { parseTrace, serializeTrace } from "../src/trace.ts"
import { TEST_PRICING } from "./helpers.ts"

const fixtures = path.join(import.meta.dir, "fixtures")
const pricing = parsePricing({
  ...TEST_PRICING,
  models: [...TEST_PRICING.models, { match: ["claude-*"], input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 }, { match: "gpt-4-1*", input: 2, output: 8, cache_read: 0.5 }],
})
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-test-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

describe("claude-code adapter", () => {
  test("rebuilds full requests from request records, blobs and the transcript", async () => {
    const result = await importClaudeCode(path.join(fixtures, "claude-code-session.jsonl"), { subagents: false })
    expect(result.records.map((record) => record.fidelity)).toEqual(["full-request", "full-request", "full-request"])
    const [first, second, third] = result.records
    expect(first!.request!.blocks.map((block) => block.kind)).toEqual(["tool", "tool", "system", "message"])
    expect(second!.request!.blocks.filter((block) => block.kind === "message").map((block) => block.key)).toEqual(["user", "assistant", "user"])
    // Every message was resolved to content, none left as a bare hash.
    expect(third!.request!.blocks.every((block) => block.content !== undefined)).toBe(true)
    expect(third!.request!.blocks.filter((block) => block.kind === "tool").map((block) => block.key)).toEqual(["list_dir", "read_file", "web_fetch"])
    expect(result.warnings).toEqual(["main: 1 logged requests had no response (errors or interruptions); skipped"])
  })

  test("carries model, params, usage, TTL, breakpoints and identity", async () => {
    const [first] = (await importClaudeCode(path.join(fixtures, "claude-code-session.jsonl"), { subagents: false })).records
    expect(first).toMatchObject({
      v: 1,
      id: "r-1",
      session: "00000000-0000-4000-8000-000000000001",
      lane: "main",
      provider: "anthropic",
      model: "claude-opus-5-5",
      params: { max_tokens: 32000, thinking: { type: "adaptive" } },
      usage: { input_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 2000, cache_write_1h_tokens: 2000, output_tokens: 40 },
      cache_ttl_seconds: 3600,
      source: { adapter: "claude-code", version: "2.1.999" },
    })
    expect(first!.request!.blocks.filter((block) => block.breakpoint).map((block) => block.kind)).toEqual(["system", "message"])
  })

  test("the earlier requests are exact prefixes, and the tool change is found", async () => {
    const { records } = await importClaudeCode(path.join(fixtures, "claude-code-session.jsonl"), { subagents: false })
    const analysis = analyze(records, { pricing })
    expect(analysis.turns.map((turn) => turn.status)).toEqual(["cold", "hit", "miss"])
    expect(analysis.turns[1]!.prefix_change).toBeUndefined()
    expect(analysis.turns[2]!.cause).toMatchObject({ cause: "tools_changed", confidence: "confirmed", summary: "tool list changed (+1 tool: 2 → 3)" })
  })

  test("includes subagent files as their own lanes", async () => {
    const { records } = await importClaudeCode(path.join(fixtures, "claude-code-session.jsonl"), {})
    expect([...new Set(records.map((record) => record.lane))]).toEqual(["main", "agent-a1"])
    expect(records.filter((record) => record.lane === "agent-a1").map((record) => record.fidelity)).toEqual(["usage-only", "usage-only"])
    // Records are ordered by time across lanes.
    expect(records.map((record) => record.ts)).toEqual(records.map((record) => record.ts).toSorted())
  })

  test("older logs fall back to usage-only, one record per API message", async () => {
    const { records } = await importClaudeCode(path.join(fixtures, "claude-code-legacy.jsonl"), {})
    expect(records.map((record) => [record.id, record.lane, record.fidelity])).toEqual([
      ["msg_a", "main", "usage-only"],
      ["msg_b", "main", "usage-only"],
      ["msg_side", "sidechain", "usage-only"],
      ["msg_c", "main", "usage-only"],
      ["msg_d", "main", "usage-only"],
    ])
    expect(records[3]!.hints).toEqual([{ kind: "compaction", detail: "compact boundary in transcript" }])
    expect(records[0]!.cache_ttl_seconds).toBe(300)
    const causes = analyze(records, { pricing }).turns.map((turn) => turn.cause?.cause)
    expect(causes).toEqual(["cold_start", undefined, "cold_start", "compaction", "cache_expired"])
  })

  test("survives a trace round trip with content deduplicated", async () => {
    const { records } = await importClaudeCode(path.join(fixtures, "claude-code-session.jsonl"), { subagents: false })
    const text = serializeTrace(records)
    const lines = text.trim().split("\n").map((line) => JSON.parse(line))
    // The system block is written once, then referenced by hash.
    expect(lines[0].request.blocks[2].content).toBeDefined()
    expect(lines[1].request.blocks[2].content).toBeUndefined()
    expect(parseTrace(text).records).toEqual(records)
  })
})

describe("opencode adapter", () => {
  const storage = path.join(fixtures, "opencode-storage")

  test("lists sessions, newest first", async () => {
    expect((await listOpencodeSessions(storage)).map((session) => [session.id, session.parent])).toEqual([
      ["ses_main", undefined],
      ["ses_child", "ses_main"],
    ])
  })

  test("legacy JSON storage: one record per step-finish, usage-only, with hints", async () => {
    const { records, warnings } = await importOpencode(storage, {})
    expect(warnings).toEqual(["no --session given; using the most recently updated session ses_main"])
    expect(records.every((record) => record.fidelity === "usage-only")).toBe(true)
    expect(records.map((record) => [record.lane, record.model])).toEqual([
      ["main", "claude-sonnet-4-5"],
      ["main", "claude-sonnet-4-5"],
      ["subagent:ses_child", "claude-sonnet-4-5"],
      ["main", "claude-sonnet-4-5"],
      ["main", "claude-sonnet-4-5"],
      ["main", "claude-sonnet-4-5"],
      ["main", "gpt-4.1"],
    ])
    // The second call started when the first call's tool finished.
    expect(records.slice(0, 2).map((record) => record.ts)).toEqual(["2026-01-01T10:00:01.000Z", "2026-01-01T10:00:05.000Z"])
    expect(records[3]!.hints).toEqual([{ kind: "agent_switch", detail: "build → plan" }])
    expect(records[5]!.hints).toEqual([{ kind: "tool_output_pruned", detail: "old tool outputs cleared from history" }])
  })

  test("maps opencode tokens: input excludes cache, output includes reasoning, implicit providers report no writes", async () => {
    const { records } = await importOpencode(storage, { subagents: false })
    expect(records[0]!.usage).toEqual({ input_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 4000, output_tokens: 50, reported_cost: 0.0156 })
    expect(records[4]!.usage).toMatchObject({ output_tokens: 42, reasoning_tokens: 12 })
    expect(records[5]!.provider).toBe("openai")
    expect(records[5]!.usage.cache_write_tokens).toBeNull()
  })

  test("the analysis names each inferred cause", async () => {
    const { records } = await importOpencode(storage, { subagents: false })
    const turns = analyze(records, { pricing }).turns
    expect(turns.map((turn) => [turn.status, turn.cause?.cause ?? null])).toEqual([
      ["cold", "cold_start"],
      ["hit", null],
      ["miss", "tools_changed"],
      ["miss", "cache_expired"],
      ["partial", "tool_output_rewritten"],
      ["miss", "model_changed"],
    ])
  })

  test("v1 SQLite database gives the same records as the JSON storage", async () => {
    const file = path.join(temp, "v1.db")
    const db = new Database(file)
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    const root = path.join(storage, "storage")
    for (const name of readdirSync(path.join(root, "session", "proj_demo"))) {
      const session = await Bun.file(path.join(root, "session", "proj_demo", name)).json()
      db.run("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)", [session.id, session.projectID, session.parentID ?? null, session.title, session.time.created, session.time.updated])
    }
    for (const sessionID of readdirSync(path.join(root, "message")))
      for (const name of readdirSync(path.join(root, "message", sessionID))) {
        const message = await Bun.file(path.join(root, "message", sessionID, name)).json()
        db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [message.id, sessionID, message.time.created, message.time.created, JSON.stringify(message)])
        for (const partName of safeList(path.join(root, "part", message.id))) {
          const part = await Bun.file(path.join(root, "part", message.id, partName)).json()
          // In the database each step-start row has its own time; use the time the JSON layout implies.
          const time = part.type === "step-start" && part.id === "prt_004" ? message.time.created + 4000 : message.time.created
          db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [part.id, message.id, sessionID, time, time, JSON.stringify(part)])
        }
      }
    db.close()
    const fromDb = await importOpencode(file, { session: "ses_main" })
    const fromJson = await importOpencode(storage, { session: "ses_main" })
    expect(fromDb.records).toEqual(fromJson.records)
    expect(fromDb.warnings).toEqual([])
  })

  test("newer SQLite layout: one assistant row per call, compaction rows, agent switches", async () => {
    const file = path.join(temp, "next.db")
    const db = new Database(file)
    db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
    db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)")
    db.run("INSERT INTO session_v2 VALUES ('ses_n', NULL, 'next layout', 0, 5000)")
    const T0 = Date.parse("2026-01-01T10:00:00Z")
    const tokens = (input: number, read: number, write: number) => ({ input, output: 20, reasoning: 0, cache: { read, write } })
    const model = { id: "claude-opus-5-5", providerID: "anthropic" }
    const rows: [string, string, number, object][] = [
      ["m1", "user", 0, { text: "hi" }],
      ["m2", "assistant", 1, { agent: "build", model, content: [], tokens: tokens(5, 0, 3000), cost: 0.02, time: { created: T0 + 1000 } }],
      ["m3", "assistant", 5, { agent: "build", model, content: [], tokens: tokens(5, 3000, 200), cost: 0.01, time: { created: T0 + 5000 } }],
      ["m4", "compaction", 9, { status: "completed", reason: "auto", summary: "s", model, tokens: tokens(5, 3200, 100), cost: 0.01, time: { created: T0 + 9000 } }],
      ["m5", "agent-switched", 12, { agent: "plan", previous: "build", time: { created: T0 + 12000 } }],
      ["m6", "assistant", 13, { agent: "plan", model, content: [], tokens: tokens(5, 0, 900), cost: 0.01, time: { created: T0 + 13000 } }],
    ]
    rows.forEach(([id, type, seconds, data], seq) => db.run("INSERT INTO session_message VALUES (?, 'ses_n', ?, ?, ?, ?, ?)", [id, type, seq, T0 + seconds * 1000, T0 + seconds * 1000, JSON.stringify(data)]))
    db.close()
    const { records } = await importOpencode(file, { session: "ses_n" })
    expect(records.map((record) => [record.id, record.hints?.map((hint) => hint.kind) ?? []])).toEqual([
      ["m2", []],
      ["m3", []],
      ["m4", ["compaction", "compaction_call"]],
      ["m6", ["agent_switch", "compaction"]],
    ])
    expect(records[0]!.usage.cache_write_tokens).toBe(3000)
  })

  test("rejects paths that are not opencode storage", async () => {
    await expect(importOpencode(fixtures, {})).rejects.toThrow("neither an opencode database nor a storage directory")
    await expect(importOpencode(storage, { session: "nope" })).rejects.toThrow("session nope not found")
  })

  test("provider families", () => {
    expect(providerFamily("amazon-bedrock", "anthropic.claude-sonnet-4")).toBe("anthropic")
    expect(providerFamily("openrouter", "anthropic/claude-opus-4.1")).toBe("anthropic")
    expect(providerFamily("github-copilot", "gpt-4.1")).toBe("openai")
    expect(providerFamily("google", "gemini-2.5-pro")).toBe("gemini")
    expect(providerFamily("opencode", "qwen3-coder")).toBe("opencode")
  })
})

describe("adapter registry", () => {
  test("each adapter declares its fidelity", () => {
    expect(findAdapter("claude-code")?.fidelity).toBe("full-request")
    expect(findAdapter("opencode")?.fidelity).toBe("usage-only")
    expect(findAdapter("nope")).toBeUndefined()
  })
})

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
