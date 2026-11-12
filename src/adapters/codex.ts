// Codex CLI rollout files, ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl.
//
// Each line is { timestamp, type, payload }. A rollout is one thread: the
// session (session_meta), each turn's settings (turn_context: model,
// collaboration mode), the history items, and per-response token usage:
// token_usage_record lines in newer versions, event_msg token_count events in
// older ones (where one response can be reported twice with the same running
// total). A subagent is a thread of its own, in a file of its own: its
// session_meta has its own `id`, the root thread's `session_id` and a
// `parent_thread_id`, so it becomes a lane of the root session. A forked
// subagent's file starts with a copy of its parent's history (and a second
// session_meta); what that copy holds happened before the subagent existed.
//
// Usage follows the Responses API (Codex copies it from response.completed):
// input_tokens includes cached_input_tokens and cache_write_input_tokens, and
// output_tokens includes reasoning_output_tokens.
//
// What a rollout does not have is a verifiable copy of each request: newer
// versions log every input item (tool declarations included, as an
// `additional_tools` item), older ones send the tool list outside the logged
// items, and no version logs a request hash or the full parameters. So every
// record is usage-only. Hints carry what the log does show: compactions (and
// which call was the compaction), collaboration-mode switches, and tool-list
// changes. Newer versions log a `world_state` line: a full snapshot of the
// thread's settings first, then partial updates that carry only the top-level
// keys that changed. Its `top_level_tools` maps each tool name to a hash of the
// tool's definition, so a change to that map between two calls is a tool-list
// change even though the request itself is not known.

import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { isRecord } from "../canonical.ts"
import type { Hint, TraceRecord, Usage } from "../trace.ts"
import type { ImportOptions, ImportResult } from "./index.ts"
import { providerFamily } from "../provider.ts"

type Json = Record<string, unknown>

export async function importCodex(input: string, options: ImportOptions): Promise<ImportResult> {
  const files = await rolloutFiles(input)
  if (files.length === 0) throw new Error(`no Codex rollout files (*.jsonl) found in ${input}`)
  const warnings: string[] = []
  const sessions = await Promise.all(files.map(async (file) => readRollout(file, await readFile(file, "utf8"), warnings)))
  // A session id names the root thread and its subagents; a thread id names that thread alone.
  const chosen = options.session ? sessions.filter((session) => session.id === options.session || session.thread === options.session) : sessions
  if (options.session && chosen.length === 0) throw new Error(`session ${options.session} not found in ${input}`)
  const records = chosen
    .flatMap((session) => session.records)
    .filter((record) => options.subagents !== false || record.lane === "main")
    .toSorted((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  const empty = chosen.filter((session) => session.records.length === 0).length
  if (empty > 0) warnings.push(`${empty} of ${chosen.length} rollout files have no token usage; skipped`)
  if (records.length > 0)
    warnings.push("codex: call timestamps are when each response finished (Codex does not log request start times), so gaps between calls are measured end to end")
  return { records, warnings }
}

async function rolloutFiles(input: string): Promise<string[]> {
  const info = await stat(input)
  if (info.isFile()) return [input]
  const names = await readdir(input, { recursive: true })
  return names
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(input, name))
}

function readRollout(file: string, text: string, warnings: string[]) {
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  const entries = lines.map(parse).filter((entry) => entry !== undefined)
  if (entries.length < lines.length) warnings.push(`${path.basename(file)}: skipped ${lines.length - entries.length} unreadable lines`)
  // The first session_meta is this thread's; a fork repeats its parent's after it.
  const meta = entries.find((entry) => entry.type === "session_meta")?.payload
  const metaPayload = isRecord(meta) ? meta : {}
  const thread = str(metaPayload.id) ?? str(metaPayload.session_id) ?? path.basename(file, ".jsonl")
  const session = str(metaPayload.session_id) ?? thread
  const forked = str(metaPayload.forked_from_id) !== undefined
  const providerId = str(metaPayload.model_provider) ?? "openai"
  const version = str(metaPayload.cli_version)
  // Newer versions log a token_usage_record per response and repeat it as a token_count event; use the records alone.
  const recordsOnly = entries.some((entry) => entry.type === "token_usage_record")
  const compactionCalls = new Set(
    entries.flatMap((entry) => (entry.type === "compacted" && isRecord(entry.payload) && str(entry.payload.compaction_response_id) ? [str(entry.payload.compaction_response_id)] : [])),
  )
  // Codex signed in with ChatGPT logs the plan's rate limits, with its plan type, on each token_count event.
  const subscription = entries.some((entry) => isRecord(entry.payload) && entry.payload.type === "token_count" && isRecord(entry.payload.rate_limits) && str(entry.payload.rate_limits.plan_type) !== undefined)
  const records: TraceRecord[] = []
  let model = ""
  let mode: string | undefined
  let pending: Hint[] = []
  let lastTotal: string | undefined
  let tools: Record<string, string> | undefined
  for (const entry of entries) {
    const payload = isRecord(entry.payload) ? entry.payload : {}
    if (entry.type === "turn_context") {
      model = str(payload.model) ?? model
      const next = isRecord(payload.collaboration_mode) ? str(payload.collaboration_mode.mode) : undefined
      if (mode && next && next !== mode) pending.push({ kind: "agent_switch", detail: `${mode} → ${next}` })
      mode = next ?? mode
      continue
    }
    if (entry.type === "world_state" && isRecord(payload.state)) {
      // A partial update carries a changed key whole; a full snapshot without the key does not know the tools.
      const next = isToolMap(payload.state.top_level_tools) ? payload.state.top_level_tools : payload.full === true ? undefined : tools
      const change = tools && next && records.length > 0 ? toolChange(tools, next) : undefined
      if (change) pending = [...pending.filter((hint) => hint.kind !== "tools_changed"), { kind: "tools_changed", detail: change }]
      tools = next
      continue
    }
    if (entry.type === "compacted" || (entry.type === "event_msg" && payload.type === "context_compacted")) {
      // In a fork, a compaction before the thread's first call is the parent's, copied with its history.
      if (forked && records.length === 0) continue
      if (!pending.some((hint) => hint.kind === "compaction")) pending.push({ kind: "compaction", detail: "history compacted" })
      continue
    }
    const usage = usageLine(entry, payload, recordsOnly)
    if (!usage) continue
    if (usage.total !== undefined) {
      // Older versions emit token_count twice for one response; the running total does not move.
      if (usage.total === lastTotal) continue
      lastTotal = usage.total
    }
    const id = str(payload.response_id)
    const lane = str(payload.thread_id) ?? thread
    const hints = [...pending, ...(id && compactionCalls.has(id) ? [{ kind: "compaction_call" }] : [])]
    records.push({
      v: 1,
      ...(id ? { id } : {}),
      session,
      lane: lane === session ? "main" : `subagent:${lane}`,
      ts: str(entry.timestamp) ?? new Date(0).toISOString(),
      provider: providerFamily(providerId, model),
      model,
      fidelity: "usage-only",
      usage: toUsage(usage.usage),
      ...(subscription ? { billing: "subscription" as const } : {}),
      ...(hints.length > 0 ? { hints } : {}),
      source: { adapter: "codex", ...(version ? { version } : {}), ...(providerId !== "openai" ? { provider_id: providerId } : {}) },
    })
    pending = []
  }
  return { id: session, thread, records }
}

function isToolMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((hash) => typeof hash === "string")
}

/** "+1 tool (web_search), 1 definition changed (shell)", or undefined when the maps are equal. */
function toolChange(before: Record<string, string>, after: Record<string, string>): string | undefined {
  const added = Object.keys(after).filter((name) => !(name in before))
  const removed = Object.keys(before).filter((name) => !(name in after))
  const changed = Object.keys(after).filter((name) => name in before && before[name] !== after[name])
  const count = (list: string[], words: string) => `${list.length} ${words.replace("#", list.length === 1 ? "" : "s")} (${list.sort().join(", ")})`
  const parts = [
    ...(added.length > 0 ? [`+${count(added, "tool#")}`] : []),
    ...(removed.length > 0 ? [`-${count(removed, "tool#")}`] : []),
    ...(changed.length > 0 ? [count(changed, "definition# changed")] : []),
  ]
  return parts.length === 0 ? undefined : `${parts.join(", ")}; ${Object.keys(before).length} → ${Object.keys(after).length} tools`
}

function usageLine(entry: Json, payload: Json, recordsOnly: boolean): { usage: Json; total?: string } | undefined {
  if (recordsOnly) return entry.type === "token_usage_record" && isRecord(payload.usage) ? { usage: payload.usage } : undefined
  if (entry.type !== "event_msg" || payload.type !== "token_count" || !isRecord(payload.info)) return undefined
  const info = payload.info
  if (!isRecord(info.last_token_usage)) return undefined
  return { usage: info.last_token_usage, total: JSON.stringify(info.total_token_usage ?? null) }
}

/**
 * Responses API convention, which Codex copies from response.completed: input_tokens includes cached and
 * cache-write tokens, output_tokens includes reasoning. Checked against Codex's source and its logged totals.
 */
function toUsage(raw: Json): Usage {
  const input = count(raw.input_tokens)
  const cached = Math.min(input, count(raw.cached_input_tokens))
  const write = Math.min(input - cached, count(raw.cache_write_input_tokens))
  const reasoning = count(raw.reasoning_output_tokens)
  return {
    input_tokens: input - cached - write,
    cache_read_tokens: cached,
    cache_write_tokens: write > 0 ? write : null,
    output_tokens: count(raw.output_tokens),
    ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
  }
}

function parse(line: string): Json | undefined {
  try {
    const value = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}
