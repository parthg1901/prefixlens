// Claude Code session logs: ~/.claude/projects/<project>/<session>.jsonl, with
// subagent logs in <session>/subagents/agent-*.jsonl.
//
// Recent Claude Code versions log the request side of every API call:
//   api-request-shape  { shapeHash, shape: { system, tools } }
//   api-request-blob   { hash, message }            one wire message, by hash
//   api-request        { id, base?, keep, tail[], shapeHash, params, cacheControl[], timestamp, querySource }
// A request's messages are the first `keep` messages of its `base` request
// followed by the messages named in `tail`. Blobs are only written for wire
// messages that differ from the transcript; the rest are found by hashing
// messages rebuilt from transcript records (sha256 of key-sorted JSON).
// Responses are the transcript's `assistant` records, linked by `requestRef`.
//
// Older logs have no api-request records; for them the adapter falls back to
// usage-only records, one per assistant message id.

import { createHash } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { canonicalizeAnthropic, isRecord } from "../canonical.ts"
import type { Block, Hint, TraceRecord } from "../trace.ts"
import { normalizeUsage } from "../usage.ts"
import type { ImportOptions, ImportResult } from "./index.ts"

type Entry = Record<string, unknown>

export async function importClaudeCode(input: string, options: ImportOptions): Promise<ImportResult> {
  const files = await sessionFiles(input, options.subagents ?? true)
  const warnings: string[] = []
  let costState: Entry | undefined
  const records = (
    await Promise.all(
      files.map(async (file, index) => {
        const entries = parseLines(await Bun.file(file.path).text(), file.path, warnings)
        if (index === 0) costState = entries.findLast((entry) => entry.type === "cost-state")
        return entries.some((entry) => entry.type === "api-request")
          ? fullRecords(entries, file.lane, warnings)
          : usageRecords(entries, file.lane, warnings)
      }),
    )
  ).flat()
  records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  if (costState && (options.subagents ?? true)) warnings.push(...compareCostState(costState, records))
  return { records, warnings }
}

/**
 * Claude Code keeps its own running token totals per model. When they exceed
 * what the per-call records add up to, some calls (compaction summaries, side
 * queries, failed requests) were billed but not logged call by call.
 */
function compareCostState(state: Entry, records: TraceRecord[]): string[] {
  if (!isRecord(state.modelUsage)) return []
  return Object.entries(state.modelUsage).flatMap(([model, usage]) => {
    if (!isRecord(usage)) return []
    const theirs = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"].reduce((sum, key) => sum + Number(usage[key] ?? 0), 0)
    const ours = records
      .filter((record) => record.model === model)
      .reduce((sum, record) => sum + record.usage.input_tokens + record.usage.cache_read_tokens + (record.usage.cache_write_tokens ?? 0), 0)
    if (theirs - ours <= Math.max(1000, ours * 0.002)) return []
    const cost = typeof usage.costUSD === "number" ? `; Claude Code puts its cost at ${usage.costUSD.toFixed(2)} USD` : ""
    return [
      `Claude Code's own totals for ${model} show ${(theirs - ours).toLocaleString("en-US")} more prompt tokens than the logged calls${cost}. Calls such as compaction summaries or side queries are billed but not logged one by one.`,
    ]
  })
}

async function sessionFiles(input: string, subagents: boolean) {
  const info = await stat(input)
  if (info.isDirectory()) {
    const names = (await readdir(input)).filter((name) => name.endsWith(".jsonl")).sort()
    if (names.length === 0) throw new Error(`no .jsonl files in ${input}`)
    return names.map((name) => ({ path: path.join(input, name), lane: laneName(name) }))
  }
  const main = { path: input, lane: "main" }
  if (!subagents) return [main]
  const dir = path.join(path.dirname(input), path.basename(input, ".jsonl"), "subagents")
  const names = await readdir(dir).catch(() => [] as string[])
  return [
    main,
    ...names
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => ({ path: path.join(dir, name), lane: laneName(name) })),
  ]
}

function laneName(file: string): string {
  return path.basename(file, ".jsonl")
}

function parseLines(text: string, file: string, warnings: string[]): Entry[] {
  let bad = 0
  const entries = text.split("\n").flatMap((line) => {
    if (line.trim() === "") return []
    try {
      const value = JSON.parse(line)
      return isRecord(value) ? [value] : []
    } catch {
      bad++
      return []
    }
  })
  if (bad > 0) warnings.push(`${path.basename(file)}: skipped ${bad} unreadable lines`)
  return entries
}

function fullRecords(entries: Entry[], lane: string, warnings: string[]): TraceRecord[] {
  const shapes = new Map<string, Entry>()
  const blobs = new Map<string, unknown>()
  const requests: Entry[] = []
  for (const entry of entries) {
    if (entry.type === "api-request-shape" && typeof entry.shapeHash === "string" && isRecord(entry.shape)) shapes.set(entry.shapeHash, entry.shape)
    if (entry.type === "api-request-blob" && typeof entry.hash === "string") blobs.set(entry.hash, wireForm(entry.hash, entry.message))
    if (entry.type === "api-request" && typeof entry.id === "string") requests.push(entry)
  }
  const responses = responsesByRequest(entries)
  const transcript = transcriptMessages(entries)
  const byId = new Map(requests.map((request) => [request.id as string, request]))
  const memo = new Map<string, string[]>()
  const messageHashes = (id: string, seen = new Set<string>()): string[] => {
    const cached = memo.get(id)
    if (cached) return cached
    const request = byId.get(id)
    if (!request || seen.has(id)) return []
    seen.add(id)
    const keep = typeof request.keep === "number" ? request.keep : 0
    const base = typeof request.base === "string" ? request.base : undefined
    const inherited = base ? messageHashes(base, seen) : []
    // A base that is not in this file still fixes the first `keep` positions; give
    // them stable placeholder identities so later requests compare correctly.
    const prefix = base && inherited.length < keep ? Array.from({ length: keep }, (_, index) => inherited[index] ?? `missing:${base}:${index}`) : inherited.slice(0, keep)
    const hashes = [...prefix, ...(Array.isArray(request.tail) ? request.tail.filter((hash): hash is string => typeof hash === "string") : [])]
    memo.set(id, hashes)
    return hashes
  }
  // Requests share almost all of their blocks, so each shape and message is canonicalized once.
  const shapeMemo = new Map<string, Block[]>()
  const shapeBlocks = (hash: string, shape: Entry | undefined) => {
    const known = shapeMemo.get(hash)
    if (known) return known
    const blocks = canonicalizeAnthropic({ tools: shape?.tools, system: shape?.system, messages: [] }).blocks.map(withoutBreakpoint)
    shapeMemo.set(hash, blocks)
    return blocks
  }
  const messageMemo = new Map<string, Block>()
  let unresolved = 0
  const messageBlock = (hash: string): Block => {
    const known = messageMemo.get(hash)
    if (known) return known
    const message = blobs.get(hash) ?? transcript.get(hash)
    if (message === undefined) unresolved++
    // A message whose content is not in the log is still identified by its hash.
    const block = message === undefined ? { kind: "message" as const, hash: `cc:${hash}` } : withoutBreakpoint(canonicalizeAnthropic({ messages: [message] }).blocks[0]!)
    messageMemo.set(hash, block)
    return block
  }
  const sessionHints = hintsByTime(entries)
  let missingShape = 0
  let noResponse = 0
  let mismatched = 0
  let unverified = 0
  const records = requests.flatMap((request): TraceRecord[] => {
    const id = request.id as string
    const response = responses.get(id)
    if (!response) {
      noResponse++
      return []
    }
    const shape = shapes.get(request.shapeHash as string)
    if (!shape) missingShape++
    const hashes = messageHashes(id)
    const messages = hashes.map((hash) => blobs.get(hash) ?? transcript.get(hash))
    const params = isRecord(request.params) ? request.params : {}
    const check = shape && !messages.includes(undefined) ? verifyDigest(request, params, shape, messages) : "unverifiable"
    // A rebuilt request that does not match what Claude Code says it sent would
    // produce wrong diffs; keep its usage but do not claim to know the request.
    if (check === "mismatch") {
      mismatched++
      return [usageRecord(request, response, lane, params, sessionHints)]
    }
    if (check === "unverifiable") unverified++
    const blocks = applyBreakpoints([...shapeBlocks(request.shapeHash as string, shape), ...hashes.map(messageBlock)], request.cacheControl)
    const message = response.message as Entry
    const ts = typeof request.timestamp === "string" ? request.timestamp : (response.timestamp as string)
    const hints = sessionHints(ts)
    return [
      {
        v: 1,
        id,
        ...(typeof request.sessionId === "string" ? { session: request.sessionId } : {}),
        lane: laneOf(request, lane),
        ts,
        provider: "anthropic",
        model: typeof message.model === "string" ? message.model : String(params.model ?? ""),
        params: canonicalizeAnthropic({ ...params, messages: [] }).params,
        fidelity: "full-request",
        request: { blocks },
        usage: normalizeUsage("anthropic", message.usage),
        cache_ttl_seconds: ttlOf(request.cacheControl),
        ...(hints.length > 0 ? { hints } : {}),
        source: { adapter: "claude-code", ...(typeof request.version === "string" ? { version: request.version } : {}), request: check },
      },
    ]
  })
  if (mismatched > 0)
    warnings.push(
      `${lane}: ${mismatched} requests rebuilt from the log did not match the request digest Claude Code recorded; imported as usage-only`,
    )
  if (unverified > 0)
    warnings.push(`${lane}: ${unverified} requests could not be checked against Claude Code's request digest (content or digest missing)`)
  if (noResponse > 0) warnings.push(`${lane}: ${noResponse} logged requests had no response (errors or interruptions); skipped`)
  if (missingShape > 0) warnings.push(`${lane}: ${missingShape} requests referenced a tools/system shape that is not in the log`)
  if (unresolved > 0)
    warnings.push(`${lane}: ${unresolved} distinct messages could not be resolved to content; they are compared by hash only`)
  return records
}

/**
 * Claude Code records `requestDigest`, the SHA-256 of the key-sorted JSON of the
 * request body it sent ({...params, system, tools, messages} with cache_control
 * set at the logged paths). Rebuilding that body and matching the digest proves
 * the reconstruction is exactly the request.
 */
function verifyDigest(request: Entry, params: Entry, shape: Entry, messages: unknown[]): "verified" | "mismatch" | "unverifiable" {
  if (typeof request.requestDigest !== "string") return "unverifiable"
  const body: Entry = { ...params, system: shape.system, tools: shape.tools, messages }
  for (const mark of Array.isArray(request.cacheControl) ? request.cacheControl : []) {
    if (!isRecord(mark) || !Array.isArray(mark.path) || mark.path.length === 0) return "unverifiable"
    // Copy only the nodes along the path, so the shared transcript messages are never mutated.
    let node: Entry = body
    for (const key of mark.path) {
      const child: unknown = node[key as string]
      if (!isRecord(child) && !Array.isArray(child)) return "mismatch"
      const copy: unknown[] | Entry = Array.isArray(child) ? [...child] : { ...child }
      node[key as string] = copy
      node = copy as Entry
    }
    node.cache_control = mark.value
  }
  return ccHash(body) === request.requestDigest ? "verified" : "mismatch"
}

/** A call whose request could not be trusted: its usage alone. */
function usageRecord(request: Entry, response: Entry, lane: string, params: Entry, hints: (ts: string) => Hint[]): TraceRecord {
  const message = response.message as Entry
  const ts = typeof request.timestamp === "string" ? request.timestamp : (response.timestamp as string)
  const found = hints(ts)
  return {
    v: 1,
    id: request.id as string,
    ...(typeof request.sessionId === "string" ? { session: request.sessionId } : {}),
    lane: laneOf(request, lane),
    ts,
    provider: "anthropic",
    model: typeof message.model === "string" ? message.model : String(params.model ?? ""),
    fidelity: "usage-only",
    usage: normalizeUsage("anthropic", message.usage),
    ...(ttlOf(request.cacheControl) ? { cache_ttl_seconds: ttlOf(request.cacheControl) } : {}),
    ...(found.length > 0 ? { hints: found } : {}),
    source: { adapter: "claude-code", ...(typeof request.version === "string" ? { version: request.version } : {}), request: "mismatch" },
  }
}

// Side queries in the main file (compaction, titles) get their own lane.
function laneOf(request: Entry, lane: string): string {
  return lane === "main" && typeof request.querySource === "string" && request.querySource !== "sdk" && request.querySource !== "repl_main_thread"
    ? request.querySource
    : lane
}

/** One response per API call: the last transcript record carrying its usage. */
function responsesByRequest(entries: Entry[]): Map<string, Entry> {
  const out = new Map<string, Entry>()
  for (const entry of entries) {
    if (entry.type !== "assistant" || typeof entry.requestRef !== "string") continue
    if (!isRecord(entry.message) || !isRecord(entry.message.usage) || entry.message.model === "<synthetic>") continue
    out.set(entry.requestRef, entry)
  }
  return out
}

/**
 * Messages rebuilt from the transcript, keyed by Claude Code's message hash.
 * Covers the forms the wire messages take: an assistant turn split across
 * several records, a user string body sent as a text part, and consecutive
 * user records sent as one message.
 */
function transcriptMessages(entries: Entry[]): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const add = (message: unknown) => out.set(ccHash(message), message)
  const parts = (content: unknown) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [])
  const turns = new Map<string, Entry[]>()
  let run: Entry[] = []
  const flush = () => {
    if (run.length > 1) add({ role: "user", content: run.flatMap((entry) => parts((entry.message as Entry).content)) })
    run = []
  }
  for (const entry of entries) {
    if (!isRecord(entry.message)) continue
    if (entry.type === "assistant") {
      flush()
      const key = typeof entry.requestRef === "string" ? entry.requestRef : String(entry.message.id ?? entry.uuid)
      turns.set(key, [...(turns.get(key) ?? []), entry])
      add({ role: "assistant", content: entry.message.content })
    }
    if (entry.type === "user") {
      run.push(entry)
      add(entry.message)
      add({ role: entry.message.role, content: entry.message.content })
      add({ role: entry.message.role, content: parts(entry.message.content) })
    }
  }
  flush()
  for (const group of turns.values()) add({ role: "assistant", content: group.flatMap((entry) => parts((entry.message as Entry).content)) })
  return out
}

/**
 * Some blobs are logged with a string body while the message Claude Code
 * hashed and sent had it as one text part. Returns the form whose hash is the
 * blob's key, so the rebuilt request is the one that was sent.
 */
function wireForm(hash: string, message: unknown): unknown {
  if (!isRecord(message) || typeof message.content !== "string" || ccHash(message) === hash) return message
  const parts = { ...message, content: [{ type: "text", text: message.content }] }
  return ccHash(parts) === hash ? parts : message
}

/** Claude Code's message hash: SHA-256 of JSON with keys sorted at every depth. */
function ccHash(message: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(message))).digest("hex")
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  )
}

/** Applies the logged cache_control positions (paths into the request) as breakpoints. */
function applyBreakpoints(blocks: Block[], cacheControl: unknown): Block[] {
  const toolCount = blocks.filter((block) => block.kind === "tool").length
  const headCount = blocks.filter((block) => block.kind !== "message").length
  const marked = new Set<number>()
  for (const mark of Array.isArray(cacheControl) ? cacheControl : []) {
    if (!isRecord(mark) || !Array.isArray(mark.path) || typeof mark.path[1] !== "number") continue
    const [area, index] = mark.path as [unknown, number]
    if (area === "tools") marked.add(index)
    if (area === "system") marked.add(toolCount + index)
    if (area === "messages") marked.add(headCount + index)
  }
  // Blocks are shared between requests, so only the marked ones are copied.
  for (const index of marked) if (blocks[index]) blocks[index] = { ...blocks[index]!, breakpoint: true }
  return blocks
}

function withoutBreakpoint(block: Block): Block {
  if (block.breakpoint === undefined) return block
  const { breakpoint, ...rest } = block
  return rest
}

// The TTL that governs the conversation prefix is the one on the last breakpoint.
function ttlOf(cacheControl: unknown): number | undefined {
  const marks = Array.isArray(cacheControl) ? cacheControl.filter(isRecord) : []
  const last = marks.at(-1)
  if (!last || !isRecord(last.value)) return undefined
  return last.value.ttl === "1h" ? 3600 : 300
}

/** Compaction boundaries in the transcript, attached to the first call after each. */
function hintsByTime(entries: Entry[]): (ts: string) => Hint[] {
  const boundaries = entries
    .filter((entry) => entry.type === "system" && entry.subtype === "compact_boundary" && typeof entry.timestamp === "string")
    .map((entry) => Date.parse(entry.timestamp as string))
    .sort((a, b) => a - b)
  let previous = Number.NEGATIVE_INFINITY
  return (ts) => {
    const now = Date.parse(ts)
    const hit = boundaries.some((time) => time > previous && time <= now)
    previous = now
    return hit ? [{ kind: "compaction", detail: "compact boundary in transcript" }] : []
  }
}

/** Fallback for logs without request records: one usage-only record per assistant message. */
function usageRecords(entries: Entry[], lane: string, warnings: string[]): TraceRecord[] {
  const groups = new Map<string, Entry[]>()
  for (const entry of entries) {
    if (entry.type !== "assistant" || !isRecord(entry.message) || !isRecord(entry.message.usage)) continue
    if (entry.message.model === "<synthetic>") continue
    const key = String(entry.message.id ?? entry.requestId ?? entry.uuid)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const sessionHints = hintsByTime(entries)
  if (groups.size === 0) warnings.push(`${lane}: no assistant responses with usage found`)
  // The request's breakpoints are not logged, but the usage says which TTL its
  // cache writes used; carry the last one seen forward per lane.
  const ttls = new Map<string, number>()
  return [...groups.entries()].map(([id, group]): TraceRecord => {
    const first = group[0]!
    const last = group.at(-1)!
    const message = last.message as Entry
    const ts = String(first.timestamp)
    const hints = sessionHints(ts)
    // Old logs kept sidechains inline in the main file; subagent files are already their own lane.
    const recordLane = first.isSidechain === true && lane === "main" ? "sidechain" : lane
    const creation = isRecord(message.usage) && isRecord(message.usage.cache_creation) ? message.usage.cache_creation : {}
    const oneHour = Number(creation.ephemeral_1h_input_tokens ?? 0)
    const fiveMinute = Number(creation.ephemeral_5m_input_tokens ?? 0)
    if (oneHour > 0 || fiveMinute > 0) ttls.set(recordLane, oneHour >= fiveMinute ? 3600 : 300)
    const ttl = ttls.get(recordLane)
    return {
      v: 1,
      id,
      ...(typeof first.sessionId === "string" ? { session: first.sessionId } : {}),
      lane: recordLane,
      ts,
      provider: "anthropic",
      model: String(message.model ?? ""),
      fidelity: "usage-only",
      usage: normalizeUsage("anthropic", message.usage),
      ...(ttl ? { cache_ttl_seconds: ttl } : {}),
      ...(hints.length > 0 ? { hints } : {}),
      source: { adapter: "claude-code", ...(typeof first.version === "string" ? { version: first.version } : {}) },
    }
  })
}
