// opencode local storage, ~/.local/share/opencode (XDG data dir; also on macOS).
//
// Three layouts are read:
// - SQLite opencode.db, v1 tables: session, message, part. Each row's `data`
//   column is JSON. An assistant message can span several model calls; each
//   call ends with a `step-finish` part that carries that call's tokens.
// - SQLite opencode.db, newer tables: session_v2, session_message. Each
//   `assistant` row is one model call with its own tokens; `compaction` rows
//   record the compaction call.
// - Legacy JSON files: storage/session/<project>/<id>.json,
//   storage/message/<session>/<id>.json, storage/part/<message>/<id>.json,
//   with the same shapes as the v1 `data` columns.
//
// opencode stores the conversation and per-call usage, but not the request it
// sent (system prompt, tool list, exact replayed history), so every record is
// usage-only. Hints carry what the log does show: compactions, agent
// switches, and tool outputs pruned from history.

import { Database } from "bun:sqlite"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { isRecord } from "../canonical.ts"
import type { Hint, TraceRecord, Usage } from "../trace.ts"
import type { ImportOptions, ImportResult, SessionSummary } from "./index.ts"

type Json = Record<string, unknown>

interface Session {
  id: string
  title?: string
  parent?: string
  updated: number
}

interface Call {
  session: string
  id: string
  ts: number
  provider: string
  model: string
  tokens: unknown
  cost?: number
  agent?: string
  compactionCall?: boolean
}

interface Source {
  sessions(): Session[]
  /** Model calls plus the timeline events used for hints, for one session. */
  calls(session: string): { calls: Call[]; events: TimelineEvent[] }
  close(): void
}

type TimelineEvent = { ts: number; hint: Hint }

export async function importOpencode(input: string, options: ImportOptions): Promise<ImportResult> {
  const source = await openSource(input)
  try {
    const sessions = source.sessions()
    if (sessions.length === 0) throw new Error(`no opencode sessions found in ${input}`)
    const warnings: string[] = []
    const chosen = options.session ? sessions.find((session) => session.id === options.session) : sessions.toSorted((a, b) => b.updated - a.updated).find((session) => !session.parent)
    if (!chosen) throw new Error(`session ${options.session} not found; run with --list to see sessions`)
    if (!options.session) warnings.push(`no --session given; using the most recently updated session ${chosen.id}`)
    const children = options.subagents === false ? [] : descendants(sessions, chosen.id)
    const records = [chosen, ...children].flatMap((session) => {
      const lane = session.id === chosen.id ? "main" : `subagent:${session.id}`
      const result = source.calls(session.id)
      return toRecords(result.calls, result.events, lane, chosen.id)
    })
    records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    if (records.length === 0) warnings.push(`session ${chosen.id} has no model calls with usage`)
    return { records, warnings }
  } finally {
    source.close()
  }
}

export async function listOpencodeSessions(input: string): Promise<SessionSummary[]> {
  const source = await openSource(input)
  try {
    return source
      .sessions()
      .toSorted((a, b) => b.updated - a.updated)
      .map((session) => ({ id: session.id, title: session.title, updated: new Date(session.updated).toISOString(), parent: session.parent }))
  } finally {
    source.close()
  }
}

function descendants(sessions: Session[], id: string): Session[] {
  const direct = sessions.filter((session) => session.parent === id)
  return direct.flatMap((child) => [child, ...descendants(sessions, child.id)])
}

async function openSource(input: string): Promise<Source> {
  const info = await stat(input)
  if (info.isFile()) return sqliteSource(input)
  if (await exists(path.join(input, "opencode.db"))) return sqliteSource(path.join(input, "opencode.db"))
  const storage = (await exists(path.join(input, "storage", "message"))) ? path.join(input, "storage") : input
  if (await exists(path.join(storage, "message"))) return jsonSource(storage)
  throw new Error(`${input} is neither an opencode database nor a storage directory`)
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

function sqliteSource(file: string): Source {
  const db = new Database(file, { readonly: true })
  const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
  const next = tables.has("session_v2") && tables.has("session_message")
  const v1 = tables.has("session") && tables.has("message") && tables.has("part")
  if (!next && !v1) {
    db.close()
    throw new Error(`${file} has no opencode session tables`)
  }
  const nextSessions = (): Session[] =>
    next
      ? db
          .query<{ id: string; title: string | null; parent_id: string | null; time_updated: number }, []>("SELECT id, title, parent_id, time_updated FROM session_v2")
          .all()
          .map((row) => ({ id: row.id, title: row.title ?? undefined, parent: row.parent_id ?? undefined, updated: row.time_updated }))
      : []
  const v1Sessions = (): Session[] =>
    v1
      ? db
          .query<{ id: string; title: string | null; parent_id: string | null; time_updated: number }, []>("SELECT id, title, parent_id, time_updated FROM session")
          .all()
          .map((row) => ({ id: row.id, title: row.title ?? undefined, parent: row.parent_id ?? undefined, updated: row.time_updated }))
      : []
  const inNext = (id: string) => next && db.query("SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1").get(id) !== null
  return {
    sessions() {
      // A migrated database has a session in both layouts; prefer the newer one.
      const sessions = new Map<string, Session>()
      for (const session of [...v1Sessions(), ...nextSessions()]) sessions.set(session.id, session)
      return [...sessions.values()]
    },
    calls(session) {
      if (inNext(session)) {
        const rows = db
          .query<{ id: string; type: string; time_created: number; data: string }, [string]>(
            "SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq",
          )
          .all(session)
        return nextCalls(session, rows.map((row) => ({ id: row.id, type: row.type, time: row.time_created, data: parse(row.data) })))
      }
      const messages = db
        .query<{ id: string; time_created: number; data: string }, [string]>("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
        .all(session)
        .map((row) => ({ id: row.id, time: row.time_created, data: parse(row.data) }))
      const parts = db
        .query<{ id: string; message_id: string; time_created: number; data: string }, [string]>(
          "SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY id",
        )
        .all(session)
        .map((row) => ({ id: row.id, message: row.message_id, time: row.time_created as number | undefined, data: parse(row.data) }))
      return v1Calls(session, messages, parts)
    },
    close: () => db.close(),
  }
}

async function jsonSource(storage: string): Promise<Source> {
  const read = async (file: string) => parse(await Bun.file(file).text())
  const list = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort()
  const sessions: Session[] = []
  for (const project of await readdir(path.join(storage, "session")).catch(() => [] as string[]))
    for (const name of await list(path.join(storage, "session", project))) {
      const data = await read(path.join(storage, "session", project, name))
      const time = isRecord(data.time) ? data.time : {}
      sessions.push({ id: str(data.id) ?? name.replace(/\.json$/, ""), title: str(data.title), parent: str(data.parentID), updated: num(time.updated) ?? 0 })
    }
  const messages = new Map<string, { id: string; time: number; data: Json }[]>()
  const parts = new Map<string, { id: string; message: string; data: Json }[]>()
  for (const session of await readdir(path.join(storage, "message")).catch(() => [] as string[])) {
    const rows = await Promise.all((await list(path.join(storage, "message", session))).map((name) => read(path.join(storage, "message", session, name))))
    messages.set(session, rows.map((data) => ({ id: String(data.id), time: num(isRecord(data.time) ? data.time.created : undefined) ?? 0, data })))
    for (const message of rows) {
      const id = String(message.id)
      const partRows = await Promise.all((await list(path.join(storage, "part", id))).map((name) => read(path.join(storage, "part", id, name))))
      parts.set(id, partRows.map((data) => ({ id: String(data.id), message: id, data })))
    }
    // A session that only has a message directory is still listed.
    if (!sessions.some((known) => known.id === session))
      sessions.push({ id: session, updated: Math.max(0, ...(messages.get(session) ?? []).map((message) => message.time)) })
  }
  return {
    sessions: () => sessions,
    calls(session) {
      const sessionMessages = (messages.get(session) ?? []).toSorted((a, b) => a.time - b.time || a.id.localeCompare(b.id))
      return v1Calls(session, sessionMessages, sessionMessages.flatMap((message) => parts.get(message.id) ?? []))
    },
    close() {},
  }
}

/** v1 layout: per-call usage on step-finish parts, falling back to the message totals. */
function v1Calls(
  session: string,
  messages: { id: string; time: number; data: Json }[],
  parts: { id: string; message: string; time?: number; data: Json }[],
): { calls: Call[]; events: TimelineEvent[] } {
  const partsByMessage = new Map<string, typeof parts>()
  for (const part of parts) partsByMessage.set(part.message, [...(partsByMessage.get(part.message) ?? []), part])
  const calls: Call[] = []
  const events: TimelineEvent[] = []
  let agent: string | undefined
  for (const message of messages) {
    const data = message.data
    const created = num(isRecord(data.time) ? data.time.created : undefined) ?? message.time
    const own = (partsByMessage.get(message.id) ?? []).toSorted((a, b) => a.id.localeCompare(b.id))
    if (data.role === "user") {
      const next = str(data.agent)
      if (agent && next && next !== agent) events.push({ ts: created, hint: { kind: "agent_switch", detail: `${agent} → ${next}` } })
      agent = next ?? agent
      if (own.some((part) => part.data.type === "compaction")) events.push({ ts: created, hint: { kind: "compaction", detail: "compaction requested" } })
      continue
    }
    if (data.role !== "assistant") continue
    for (const part of own) {
      const state = isRecord(part.data.state) ? part.data.state : {}
      const time = isRecord(state.time) ? state.time : {}
      const compacted = num(time.compacted)
      if (part.data.type === "tool" && compacted !== undefined) events.push({ ts: compacted, hint: { kind: "tool_output_pruned", detail: "old tool outputs cleared from history" } })
    }
    const base = {
      session,
      provider: str(data.providerID) ?? "",
      model: str(data.modelID) ?? "",
      agent: str(data.agent) ?? str(data.mode),
      compactionCall: data.summary === true,
    }
    const finishes = own.filter((part) => part.data.type === "step-finish")
    if (finishes.length === 0) {
      if (isRecord(data.tokens)) calls.push({ ...base, id: message.id, ts: created, tokens: data.tokens, cost: num(data.cost) })
      continue
    }
    // Each step-finish closes one model call. Its start time is the matching
    // step-start row's time when the database has one; otherwise the end of
    // the previous step's tools, which is when the next request went out.
    let cursor = created
    for (const part of own) {
      if (part.data.type === "step-start") cursor = part.time ?? cursor
      if (part.data.type === "tool") {
        const state = isRecord(part.data.state) ? part.data.state : {}
        const end = num(isRecord(state.time) ? state.time.end : undefined)
        if (end !== undefined && part.time === undefined) cursor = Math.max(cursor, end)
      }
      if (part.data.type === "step-finish") calls.push({ ...base, id: part.id, ts: cursor, tokens: part.data.tokens, cost: num(part.data.cost) })
    }
  }
  return { calls, events }
}

/** Newer layout: one assistant row per call; compaction rows carry the compaction call's usage. */
function nextCalls(session: string, rows: { id: string; type: string; time: number; data: Json }[]): { calls: Call[]; events: TimelineEvent[] } {
  const calls: Call[] = []
  const events: TimelineEvent[] = []
  for (const row of rows) {
    const data = row.data
    const created = num(isRecord(data.time) ? data.time.created : undefined) ?? row.time
    const model = isRecord(data.model) ? data.model : {}
    if (row.type === "agent-switched" && str(data.previous))
      events.push({ ts: created, hint: { kind: "agent_switch", detail: `${str(data.previous)} → ${str(data.agent)}` } })
    if (row.type === "compaction") {
      events.push({ ts: created, hint: { kind: "compaction", detail: `${str(data.reason) ?? ""} compaction`.trim() } })
      if (isRecord(data.tokens))
        calls.push({ session, id: row.id, ts: created, provider: str(model.providerID) ?? "", model: str(model.id) ?? "", tokens: data.tokens, cost: num(data.cost), compactionCall: true })
    }
    if (row.type === "assistant" && isRecord(data.tokens))
      calls.push({ session, id: row.id, ts: created, provider: str(model.providerID) ?? "", model: str(model.id) ?? "", tokens: data.tokens, cost: num(data.cost), agent: str(data.agent) })
  }
  return { calls, events }
}

function toRecords(calls: Call[], events: TimelineEvent[], lane: string, rootSession: string): TraceRecord[] {
  const sorted = events.toSorted((a, b) => a.ts - b.ts)
  let previous = Number.NEGATIVE_INFINITY
  let afterCompactionCall = false
  return calls.map((call): TraceRecord => {
    const hints: Hint[] = sorted.filter((event) => event.ts > previous && event.ts <= call.ts).map((event) => event.hint)
    if (afterCompactionCall && !hints.some((hint) => hint.kind === "compaction")) hints.push({ kind: "compaction", detail: "first call after a compaction" })
    if (call.compactionCall) hints.push({ kind: "compaction_call" })
    afterCompactionCall = call.compactionCall === true
    previous = call.ts
    return {
      v: 1,
      id: call.id,
      session: rootSession,
      lane,
      ts: new Date(call.ts).toISOString(),
      provider: providerFamily(call.provider, call.model),
      model: call.model,
      fidelity: "usage-only",
      usage: usageOf(call),
      ...(hints.length > 0 ? { hints: dedupe(hints) } : {}),
      source: { adapter: "opencode", provider_id: call.provider, ...(call.agent ? { agent: call.agent } : {}) },
    }
  })
}

function dedupe(hints: Hint[]): Hint[] {
  const seen = new Set<string>()
  return hints.filter((hint) => {
    const key = `${hint.kind}:${hint.detail ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * opencode's tokens are { input, output, reasoning, cache: { read, write } },
 * with input already excluding cached tokens and output excluding reasoning.
 * It records a write count of 0 for providers with implicit caching; those
 * become null so the analysis expects the whole prompt to be cached.
 */
function usageOf(call: Call): Usage {
  const tokens = isRecord(call.tokens) ? call.tokens : {}
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  const write = count(cache.write)
  const explicit = providerFamily(call.provider, call.model) === "anthropic" || write > 0
  const reasoning = count(tokens.reasoning)
  return {
    input_tokens: count(tokens.input),
    cache_read_tokens: count(cache.read),
    cache_write_tokens: explicit ? write : null,
    output_tokens: count(tokens.output) + reasoning,
    ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
    ...(call.cost !== undefined ? { reported_cost: call.cost } : {}),
  }
}

/** Maps an opencode provider id to the provider whose caching rules apply. */
export function providerFamily(provider: string, model: string): string {
  const id = provider.toLowerCase()
  const name = model.toLowerCase()
  if (id === "anthropic" || id.includes("bedrock") || id.includes("vertex-anthropic") || name.includes("claude")) return "anthropic"
  if (id === "openai" || id === "azure" || name.startsWith("gpt-") || /^o\d/.test(name)) return "openai"
  if (id.startsWith("google") || name.startsWith("gemini")) return "gemini"
  return id
}

function parse(text: string): Json {
  try {
    const value = JSON.parse(text)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}
