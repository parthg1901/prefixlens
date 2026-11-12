import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { importClaudeCode } from "../src/adapters/claude-code.ts"
import { findAdapter } from "../src/adapters/index.ts"
import { importOpencode, listOpencodeSessions } from "../src/adapters/opencode.ts"
import { providerFamily } from "../src/provider.ts"
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
    // The first system block is the billing-attribution line Claude Code sends but does not log.
    expect(first!.request!.blocks.map((block) => block.kind)).toEqual(["tool", "tool", "system", "system", "message"])
    expect(first!.request!.blocks[2]).toEqual({ kind: "system", key: "billing-attribution", hash: "unknown:claude-code-billing-attribution", unknown: true })
    expect(second!.request!.blocks.filter((block) => block.kind === "message").map((block) => block.key)).toEqual(["user", "assistant", "user"])
    // Every logged block was resolved to content, none left as a bare hash.
    expect(third!.request!.blocks.every((block) => block.content !== undefined || block.unknown)).toBe(true)
    expect(third!.request!.blocks.filter((block) => block.kind === "tool").map((block) => block.key)).toEqual(["list_dir", "read_file", "web_fetch"])
    expect(result.warnings).toEqual(["main: 1 logged requests had no response (errors or interruptions); skipped"])
  })

  test("checks each rebuilt request against Claude Code's request digest", async () => {
    const { records } = await importClaudeCode(path.join(fixtures, "claude-code-session.jsonl"), { subagents: false })
    expect(records.map((record) => record.source?.request)).toEqual(["verified", "verified", "verified"])
    // The first message's blob was logged as a string body; the request carried it as a text part.
    expect(records[0]!.request!.blocks.at(-1)!.content).toEqual({ role: "user", content: [{ type: "text", text: "List the files." }] })
  })

  test("a request that does not match its digest is imported usage-only", async () => {
    const text = await Bun.file(path.join(fixtures, "claude-code-session.jsonl")).text()
    const file = path.join(temp, "tampered.jsonl")
    // Change the system prompt of the second shape only: requests 3 and 4 no longer match what was sent.
    await Bun.write(file, text.replace(/("shapeHash": "8d98ec[0-9a-f]+", "shape": \{"system": \[\{"type": "text", "text": ")You are/, "$1Edited: you are"))
    const result = await importClaudeCode(file, { subagents: false })
    expect(result.records.map((record) => record.fidelity)).toEqual(["full-request", "full-request", "usage-only"])
    expect(result.records[2]!.request).toBeUndefined()
    expect(result.warnings).toContain("main: 1 requests rebuilt from the log did not match the request digest Claude Code recorded; imported as usage-only")
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

  test("survives a compact trace round trip", async () => {
    const { records } = await importClaudeCode(path.join(fixtures, "claude-code-session.jsonl"), { subagents: false })
    const text = serializeTrace(records)
    const lines = text.trim().split("\n").map((line) => JSON.parse(line))
    // Call 2 reuses call 1's tools, system prompt and first message, then lists only its new messages.
    expect(lines[1].request.reuse).toBe(5)
    expect(lines[1].request.blocks.map((block: { key?: string }) => block.key)).toEqual(["assistant", "user"])
    // Call 3 changed the tool list, so it reuses the first two tools only; the system block is written by hash.
    expect(lines[2].request.reuse).toBe(2)
    expect(lines[2].request.blocks[1]).toMatchObject({ kind: "system" })
    expect(lines[2].request.blocks[1].content).toBeUndefined()
    expect(parseTrace(text).records).toEqual(records)
    expect(parseTrace(serializeTrace(records, { compact: false })).records).toEqual(records)
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
    expect(warnings).toEqual([
      "no --session given; using the most recently updated session ses_main",
      "session ses_main's title was generated by a model call whose usage opencode does not store (unless the title was set by hand); that call is not in the trace",
    ])
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
          // A step-start row is written on the first response chunk, after the request went out; its
          // time is not the request start and must not change the records.
          const time = part.type === "step-start" && part.id === "prt_004" ? message.time.created + 6000 : message.time.created
          db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [part.id, message.id, sessionID, time, time, JSON.stringify(part)])
        }
      }
    db.close()
    const fromDb = await importOpencode(file, { session: "ses_main" })
    const fromJson = await importOpencode(storage, { session: "ses_main" })
    expect(fromDb.records).toEqual(fromJson.records)
    expect(fromDb.warnings).toEqual(fromJson.warnings)
  })

  // The tables, columns and JSON shapes of a database written by opencode 1.19.5 (`opencode run`), with
  // synthetic content: one assistant message per model call, an empty session_message table, a title
  // made by an unstored model call, and a subagent session named by the task tool.
  test("a database as opencode 1.19.5 writes it: one call per assistant message, timed from the message's creation", async () => {
    const file = path.join(temp, "release-1.19.db")
    const db = new Database(file)
    db.run(`CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL,
      path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer,
      summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text,
      permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer)`)
    db.run("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)")
    db.run("CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)")
    db.run("CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)")
    const T = Date.parse("2026-01-02T09:00:00Z")
    const model = { id: "demo-free", providerID: "opencode", variant: "default" }
    const session = (id: string, parent: string | null, title: string, updated: number) =>
      db.run(
        "INSERT INTO session (id, project_id, parent_id, slug, directory, path, title, version, cost, tokens_input, agent, model, time_created, time_updated) VALUES (?, 'prj', ?, 'demo-slug', '/work/demo', '', ?, '1.19.5', 0, 0, 'build', ?, ?, ?)",
        [id, parent, title, JSON.stringify(model), T, T + updated],
      )
    session("ses_r", null, "Counting items in a list", 30000)
    session("ses_k", "ses_r", "Count the items (@general subagent)", 20000)
    const message = (id: string, sessionID: string, at: number, data: object) => db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [id, sessionID, T + at, T + at + 1, JSON.stringify(data)])
    const part = (id: string, messageID: string, sessionID: string, at: number, data: object) => db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [id, messageID, sessionID, T + at, T + at + 1, JSON.stringify(data)])
    const tokens = (input: number, output: number, reasoning: number, read: number) => ({ total: input + output + reasoning + read, input, output, reasoning, cache: { write: 0, read } })
    const assistant = (id: string, sessionID: string, agent: string, at: number, done: number, used: object, finish: string) =>
      message(id, sessionID, at, { parentID: "msg_u", role: "assistant", mode: agent, agent, path: { cwd: "/work/demo", root: "/work/demo" }, cost: 0, tokens: used, modelID: "demo-free", providerID: "opencode", time: { created: T + at, completed: T + done }, finish })
    // One call: message created at `at`, first response chunk (step-start row) 3 s later, a tool, then the step-finish.
    const call = (n: number, sessionID: string, agent: string, at: number, used: ReturnType<typeof tokens>, finish: string) => {
      assistant(`msg_a${n}`, sessionID, agent, at, at + 5000, used, finish)
      part(`prt_${n}1`, `msg_a${n}`, sessionID, at + 3000, { snapshot: "abc", type: "step-start" })
      part(`prt_${n}2`, `msg_a${n}`, sessionID, at + 3100, { type: "reasoning", text: "thinking", time: { start: T + at + 3050, end: T + at + 3090 } })
      if (finish === "tool-calls")
        part(`prt_${n}3`, `msg_a${n}`, sessionID, at + 3200, { type: "tool", tool: "read", callID: "call_1", state: { status: "completed", input: { filePath: "/work/demo/a.txt" }, output: "x", metadata: {}, title: "a.txt", time: { start: T + at + 3300, end: T + at + 3400 } } })
      part(`prt_${n}4`, `msg_a${n}`, sessionID, at + 4000, { reason: finish, snapshot: "abc", type: "step-finish", tokens: used, cost: 0 })
    }
    message("msg_u", "ses_r", 0, { role: "user", time: { created: T }, agent: "build", model: { providerID: "opencode", modelID: "demo-free" }, summary: { diffs: [] } })
    part("prt_u", "msg_u", "ses_r", 10, { type: "text", text: "count the items" })
    call(1, "ses_r", "build", 1000, tokens(7000, 20, 10, 0), "tool-calls")
    call(2, "ses_k", "general", 6000, tokens(2000, 10, 0, 4096), "tool-calls")
    call(3, "ses_k", "general", 11500, tokens(200, 15, 5, 6000), "stop")
    call(4, "ses_r", "build", 17000, tokens(300, 5, 0, 6900), "stop")
    db.close()
    const { records, warnings } = await importOpencode(file, { session: "ses_r" })
    expect(records.map((record) => [record.id, record.lane, record.ts, record.provider, record.model])).toEqual([
      ["prt_14", "main", "2026-01-02T09:00:01.000Z", "opencode", "demo-free"],
      ["prt_24", "subagent:ses_k", "2026-01-02T09:00:06.000Z", "opencode", "demo-free"],
      ["prt_34", "subagent:ses_k", "2026-01-02T09:00:11.500Z", "opencode", "demo-free"],
      ["prt_44", "main", "2026-01-02T09:00:17.000Z", "opencode", "demo-free"],
    ])
    // input excludes cached tokens and output excludes reasoning, as the proxy showed for the same calls.
    expect(records[0]!.usage).toEqual({ input_tokens: 7000, cache_read_tokens: 0, cache_write_tokens: null, output_tokens: 30, reasoning_tokens: 10, reported_cost: 0 })
    expect(records[3]!.usage).toMatchObject({ input_tokens: 300, cache_read_tokens: 6900, output_tokens: 5 })
    expect(records.map((record) => record.source?.agent)).toEqual(["build", "general", "general", "build"])
    expect(warnings).toEqual([
      "session ses_r's title was generated by a model call whose usage opencode does not store (unless the title was set by hand); that call is not in the trace",
    ])
    expect((await listOpencodeSessions(file)).map((listed) => [listed.id, listed.parent, listed.title])).toEqual([
      ["ses_r", undefined, "Counting items in a list"],
      ["ses_k", "ses_r", "Count the items (@general subagent)"],
    ])
  })

  test("a session still under opencode's placeholder title gets no title-call warning", async () => {
    const file = path.join(temp, "placeholder-title.db")
    const db = new Database(file)
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    db.run("INSERT INTO session VALUES ('ses_p', 'prj', NULL, 'New session - 2026-01-02T09:00:00.000Z', 0, 1000)")
    db.close()
    expect((await importOpencode(file, { session: "ses_p" })).warnings).toEqual(["session ses_p has no model calls with usage"])
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

  // Table definitions as opencode's current schema creates them (session_v2, session_message), plus the
  // v1 tables an upgraded install keeps. Content is synthetic.
  const nextTables = (db: Database) => {
    db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
    db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)")
  }
  const T1 = Date.parse("2026-01-01T11:00:00Z")
  const anthropicModel = { id: "claude-opus-5-5", providerID: "anthropic" }
  const usage = (input: number, read: number, write: number) => ({ input, output: 10, reasoning: 0, cache: { read, write } })

  test("a fresh database with only the newer tables: a session without messages (an empty subagent) imports as nothing", async () => {
    const file = path.join(temp, "fresh.db")
    const db = new Database(file)
    nextTables(db)
    db.run("INSERT INTO session_v2 VALUES ('ses_root', NULL, 'root', 0, 9000)")
    db.run("INSERT INTO session_v2 VALUES ('ses_kid', 'ses_root', 'empty child', 0, 8000)")
    db.run("INSERT INTO session_message VALUES ('a1', 'ses_root', 'assistant', 0, ?, ?, ?)", [T1, T1, JSON.stringify({ agent: "build", model: anthropicModel, tokens: usage(5, 0, 2000), time: { created: T1 } })])
    db.close()
    const { records } = await importOpencode(file, { session: "ses_root" })
    expect(records.map((record) => [record.id, record.lane])).toEqual([["a1", "main"]])
    expect((await importOpencode(file, { session: "ses_kid" })).records).toEqual([])
  })

  test("an upgraded database: every v1 step is kept, the one-row copy of each v1 message is not counted again, newer rows are added", async () => {
    const file = path.join(temp, "upgraded.db")
    const db = new Database(file)
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    nextTables(db)
    db.run("INSERT INTO session VALUES ('ses_up', 'proj', NULL, 'upgraded', 0, 5000)")
    db.run("INSERT INTO session_v2 VALUES ('ses_up', NULL, 'upgraded', 0, 9000)")
    const old = { id: "msg_old", role: "assistant", providerID: "anthropic", modelID: "claude-opus-5-5", time: { created: T1 } }
    db.run("INSERT INTO message VALUES ('msg_old', 'ses_up', ?, ?, ?)", [T1, T1, JSON.stringify(old)])
    const parts: [string, number, object][] = [
      ["prt_1", T1, { type: "step-start" }],
      ["prt_2", T1 + 2000, { type: "step-finish", tokens: usage(5, 0, 2000), cost: 0.01 }],
      ["prt_3", T1 + 3000, { type: "step-start" }],
      ["prt_4", T1 + 5000, { type: "step-finish", tokens: usage(5, 2000, 100), cost: 0.002 }],
    ]
    for (const [id, time, data] of parts) db.run("INSERT INTO part VALUES (?, 'msg_old', 'ses_up', ?, ?, ?)", [id, time, time, JSON.stringify(data)])
    // The upgrade's copy: one row with the last step's tokens and the whole message's cost.
    const copy = { agent: "build", model: anthropicModel, tokens: usage(5, 2000, 100), cost: 0.012, time: { created: T1 } }
    db.run("INSERT INTO session_message VALUES ('msg_old', 'ses_up', 'assistant', 0, ?, ?, ?)", [T1, T1, JSON.stringify(copy)])
    const later = { agent: "build", model: anthropicModel, tokens: usage(5, 2100, 50), cost: 0.001, time: { created: T1 + 60000 } }
    db.run("INSERT INTO session_message VALUES ('a_new', 'ses_up', 'assistant', 1, ?, ?, ?)", [T1 + 60000, T1 + 60000, JSON.stringify(later)])
    db.close()
    const { records } = await importOpencode(file, { session: "ses_up" })
    expect(records.map((record) => [record.id, record.usage.cache_read_tokens, record.usage.reported_cost])).toEqual([
      ["prt_2", 0, 0.01],
      ["prt_4", 2000, 0.002],
      ["a_new", 2100, 0.001],
    ])
  })

  test("a data directory whose database is named for its release channel (opencode-<channel>.db)", async () => {
    const dir = path.join(temp, "channel")
    mkdirSync(dir)
    const db = new Database(path.join(dir, "opencode-local.db"))
    nextTables(db)
    db.run("INSERT INTO session_v2 VALUES ('ses_ch', NULL, 'channel', 0, 1000)")
    db.run("INSERT INTO session_message VALUES ('c1', 'ses_ch', 'assistant', 0, ?, ?, ?)", [T1, T1, JSON.stringify({ agent: "build", model: anthropicModel, tokens: usage(5, 0, 900), time: { created: T1 } })])
    db.close()
    expect((await importOpencode(dir, {})).records.map((record) => record.id)).toEqual(["c1"])
    new Database(path.join(dir, "opencode-other.db")).close()
    await expect(importOpencode(dir, {})).rejects.toThrow("several opencode databases")
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
