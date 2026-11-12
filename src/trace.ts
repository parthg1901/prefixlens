// Trace format: one JSON object per line, one line per model call. SPEC.md is
// the normative description; this file is its TypeScript form plus a reader
// that validates records once at the boundary.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { isPosition, type Position } from "./breaks.ts"
import { hashContent, isRecord } from "./canonical.ts"

/** The `v` every record carries: the major version of the format. */
export const TRACE_VERSION = 1
/** The version of SPEC.md this reader implements. Minor versions only add optional fields, so every 1.x trace reads as `v: 1`. */
export const TRACE_FORMAT_VERSION = "1.2"

export type Fidelity = "full-request" | "usage-only"
export type BlockKind = "tool" | "system" | "message"

export interface Block {
  kind: BlockKind
  /** Tool name for tools, role for messages. Informational; not hashed. */
  key?: string
  /** Lowercase hex SHA-256 of the canonical JSON of `content`. */
  hash: string
  /** The block as sent. May be omitted to redact it, in which case `hash` is required. */
  content?: unknown
  /** True when a cache breakpoint (e.g. Anthropic `cache_control`) was set on this block. */
  breakpoint?: boolean
}

export interface Usage {
  /** Input tokens neither read from nor written to the cache. */
  input_tokens: number
  cache_read_tokens: number
  /** Tokens written to the cache, or null when the provider does not report writes (implicit caching). */
  cache_write_tokens: number | null
  /** The part of cache_write_tokens written with a 1-hour TTL, when known. */
  cache_write_1h_tokens?: number
  /** All billed output tokens, including reasoning. */
  output_tokens: number
  /** The part of output_tokens spent on reasoning, when known. */
  reasoning_tokens?: number
  /** Cost the harness itself recorded for this call, in USD, when known. */
  reported_cost?: number
}

export type HintKind =
  | "compaction"
  | "compaction_call"
  | "tool_output_pruned"
  | "agent_switch"
  | "model_switch"
  | "prefix_break"
  | "tools_changed"

export interface Hint {
  /** One of HintKind; readers keep and ignore kinds they do not know. */
  kind: HintKind | (string & {})
  detail?: string
  /** `prefix_break` only: why the harness broke its prefix on purpose, e.g. "revert" (SPEC 6.1). */
  reason?: string
  /** `prefix_break` only: the last part that must stay unchanged; default depends on `reason` (SPEC 6.1). */
  after?: Position
}

export interface TraceRecord {
  v: number
  id?: string
  session?: string
  lane?: string
  ts: string
  provider: string
  model: string
  params?: Record<string, unknown>
  fidelity: Fidelity
  request?: { blocks: Block[] }
  usage: Usage
  cache_ttl_seconds?: number
  hints?: Hint[]
  /** Non-secret request headers that affect caching or routing, e.g. `session-id`. Never credentials. */
  headers?: Record<string, string>
  /**
   * True when the response ended before its final event (the client disconnected, the
   * connection broke). The input-side usage is final; output tokens are a lower bound.
   * Format 1.2. prefixlens also reads the `source.complete: false` its own recorders wrote before.
   */
  interrupted?: boolean
  source?: Record<string, unknown>
}

export interface ParseResult {
  records: TraceRecord[]
  errors: string[]
  warnings: string[]
}

/** Reads a JSONL trace. Invalid lines are reported in `errors` and skipped. */
export function parseTrace(text: string): ParseResult {
  const records: TraceRecord[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const state: ReadState = { contents: new Map(), lastBlocks: new Map() }
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return
    const parsed = parseJson(line)
    if (parsed === undefined) return errors.push(`line ${index + 1}: not valid JSON`)
    const problems: string[] = []
    const record = readRecord(parsed, problems, warnings, index + 1, state)
    if (problems.length > 0) return errors.push(...problems.map((problem) => `line ${index + 1}: ${problem}`))
    records.push(record!)
  })
  return { records, errors, warnings }
}

/**
 * Writes records as JSONL, compacted two ways so a full-request trace grows
 * with the conversation rather than its square:
 * - a record reuses the leading blocks it shares with the previous full
 *   request in its lane (`request.reuse`) and lists only the rest;
 * - block content is written the first time its hash appears; later blocks
 *   with that hash carry the hash alone.
 * With `compact: false` every record lists every block with its content.
 */
export function serializeTrace(records: TraceRecord[], options: { compact?: boolean } = {}): string {
  const encoder = createTraceEncoder(options)
  return records.map((record) => encoder.encode(record) + "\n").join("")
}

/**
 * The incremental form of `serializeTrace`: encodes one record at a time,
 * remembering what earlier lines already carried. Seed it with the records of
 * an existing file to append to that file.
 */
export function createTraceEncoder(options: { compact?: boolean; after?: TraceRecord[] } = {}) {
  const compact = options.compact ?? true
  const written = new Set<string>()
  const last = new Map<string, Block[]>()
  const remember = (record: TraceRecord) => {
    if (!record.request) return
    last.set(laneKey(record), record.request.blocks)
    for (const block of record.request.blocks) if (block.content !== undefined) written.add(block.hash)
  }
  for (const record of options.after ?? []) remember(record)
  return {
    /** One JSONL line, without the newline. */
    encode(record: TraceRecord): string {
      if (!compact || !record.request) return JSON.stringify(record)
      const all = record.request.blocks
      const previous = last.get(laneKey(record)) ?? []
      let reuse = 0
      while (reuse < previous.length && reuse < all.length && sameBlock(previous[reuse]!, all[reuse]!)) reuse++
      const blocks = all.slice(reuse).map((block) => {
        if (block.content === undefined) return block
        if (written.has(block.hash)) {
          const { content, ...rest } = block
          return rest
        }
        written.add(block.hash)
        return block
      })
      remember(record)
      return JSON.stringify({ ...record, request: { ...(reuse > 0 ? { reuse } : {}), blocks } })
    },
  }
}

/**
 * Appends records to a trace file, one complete line per call, so the file is
 * a valid trace at every moment (a crash loses at most the call in flight).
 * An existing file is read first so new lines can reference its content.
 */
export function openTraceWriter(file: string): TraceWriter {
  // Two writers on one file would each think they know what the file holds; share one per path.
  const resolved = path.resolve(file)
  const open = writers.get(resolved)
  if (open) return open
  const existing = existsSync(file) ? parseTrace(readFileSync(file, "utf8")).records : []
  const encoder = createTraceEncoder({ after: existing })
  const writer = {
    file,
    append(record: TraceRecord) {
      writePrivateFile(resolved, encoder.encode(record) + "\n", { append: true })
    },
  }
  writers.set(resolved, writer)
  return writer
}

/**
 * Writes (or appends) a file that holds trace data: prompts, code, tool
 * outputs, often an email address. A new file is created readable and
 * writable by its owner only (0600), and missing parent directories owner-only
 * (0700). A file or directory that already exists keeps its mode: prefixlens
 * never changes permissions you set (`readableByOthers` says when they are open).
 */
export function writePrivateFile(file: string, text: string, options: { append?: boolean } = {}) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 })
  if (options.append) appendFileSync(file, text, { mode: 0o600 })
  else writeFileSync(file, text, { mode: 0o600 })
}

/** True when `file` exists and its group or other users may read it. */
export function readableByOthers(file: string): boolean {
  const info = statSync(file, { throwIfNoEntry: false })
  return info !== undefined && (info.mode & 0o044) !== 0
}

export interface TraceWriter {
  file: string
  append(record: TraceRecord): void
}

const writers = new Map<string, TraceWriter>()

function sameBlock(a: Block, b: Block): boolean {
  return a.hash === b.hash && a.kind === b.kind && a.key === b.key && Boolean(a.breakpoint) === Boolean(b.breakpoint)
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function readRecord(value: unknown, problems: string[], warnings: string[], line: number, state: ReadState): TraceRecord | undefined {
  if (!isRecord(value)) {
    problems.push("record must be a JSON object")
    return undefined
  }
  if (value.v !== TRACE_VERSION) problems.push(`v must be ${TRACE_VERSION}`)
  const ts = value.ts
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) problems.push("ts must be an RFC 3339 timestamp string")
  for (const field of ["provider", "model"] as const)
    if (typeof value[field] !== "string") problems.push(`${field} must be a string`)
  for (const field of ["id", "session", "lane"] as const)
    if (value[field] !== undefined && typeof value[field] !== "string") problems.push(`${field} must be a string`)
  if (value.fidelity !== "full-request" && value.fidelity !== "usage-only")
    problems.push('fidelity must be "full-request" or "usage-only"')
  if (value.params !== undefined && !isRecord(value.params)) problems.push("params must be an object")
  if (value.headers !== undefined && !(isRecord(value.headers) && Object.values(value.headers).every((header) => typeof header === "string")))
    problems.push("headers must be an object of strings")
  if (value.interrupted !== undefined && typeof value.interrupted !== "boolean") problems.push("interrupted must be a boolean")
  if (value.cache_ttl_seconds !== undefined && !isCount(value.cache_ttl_seconds))
    problems.push("cache_ttl_seconds must be a non-negative integer")
  const usage = readUsage(value.usage, problems)
  const lane = laneKey({ session: typeof value.session === "string" ? value.session : undefined, lane: typeof value.lane === "string" ? value.lane : undefined })
  const blocks = value.fidelity === "full-request" && problems.length === 0 ? readBlocks(value.request, problems, warnings, line, state, lane) : undefined
  const hints = readHints(value.hints, problems, warnings, line)
  if (problems.length > 0) return undefined
  // prefixlens 0.3's recorders marked a cut-off call in source rather than in a field of its own.
  const legacyInterrupted = value.interrupted === undefined && isRecord(value.source) && value.source.complete === false && typeof value.source.recorder === "string"
  return {
    ...(value as unknown as TraceRecord),
    ...(legacyInterrupted ? { interrupted: true } : {}),
    usage: usage!,
    ...(blocks ? { request: { blocks } } : {}),
    ...(hints ? { hints } : {}),
  }
}

function readUsage(value: unknown, problems: string[]): Usage | undefined {
  if (!isRecord(value)) {
    problems.push("usage must be an object")
    return undefined
  }
  for (const field of ["input_tokens", "cache_read_tokens", "output_tokens"])
    if (!isCount(value[field])) problems.push(`usage.${field} must be a non-negative integer`)
  if (value.cache_write_tokens !== null && !isCount(value.cache_write_tokens))
    problems.push("usage.cache_write_tokens must be a non-negative integer or null")
  for (const field of ["cache_write_1h_tokens", "reasoning_tokens"])
    if (value[field] !== undefined && !isCount(value[field])) problems.push(`usage.${field} must be a non-negative integer`)
  if (value.reported_cost !== undefined && (typeof value.reported_cost !== "number" || value.reported_cost < 0))
    problems.push("usage.reported_cost must be a non-negative number")
  return value as unknown as Usage
}

function readBlocks(value: unknown, problems: string[], warnings: string[], line: number, state: ReadState, lane: string): Block[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.blocks)) {
    problems.push("request.blocks must be an array when fidelity is full-request")
    return undefined
  }
  const reuse = value.reuse ?? 0
  const earlier = state.lastBlocks.get(lane) ?? []
  if (!isCount(reuse)) problems.push("request.reuse must be a non-negative integer")
  else if (reuse > earlier.length)
    problems.push(`request.reuse is ${reuse} but the previous full request in lane "${lane.replace("\u0000", "/")}" has ${earlier.length} blocks`)
  const own = value.blocks.flatMap((block, index): Block[] => {
    if (!isRecord(block) || !(block.kind === "tool" || block.kind === "system" || block.kind === "message")) {
      problems.push(`request.blocks[${index}].kind must be "tool", "system" or "message"`)
      return []
    }
    if (block.key !== undefined && typeof block.key !== "string") problems.push(`request.blocks[${index}].key must be a string`)
    if (block.hash === undefined && block.content === undefined) {
      problems.push(`request.blocks[${index}] needs content or hash`)
      return []
    }
    if (block.hash !== undefined && typeof block.hash !== "string") {
      problems.push(`request.blocks[${index}].hash must be a string`)
      return []
    }
    const hash = block.hash ?? hashContent(block.content)
    if (block.hash !== undefined && block.content !== undefined && hashContent(block.content) !== block.hash)
      warnings.push(`line ${line}: request.blocks[${index}].hash does not match its content; using the given hash`)
    if (block.content !== undefined) {
      if (!state.contents.has(hash)) state.contents.set(hash, block.content)
      return [{ ...(block as unknown as Block), hash }]
    }
    // Content omitted: restore it from an earlier line with the same hash, if any.
    const known = state.contents.get(hash)
    return [{ ...(block as unknown as Block), hash, ...(known === undefined ? {} : { content: known }) }]
  })
  const blocks = [...earlier.slice(0, isCount(reuse) ? reuse : 0), ...own]
  const order: Record<BlockKind, number> = { tool: 0, system: 1, message: 2 }
  const outOfOrder = blocks.findIndex((block, index) => index > 0 && order[block.kind] < order[blocks[index - 1]!.kind])
  if (outOfOrder !== -1) problems.push(`request block ${outOfOrder}: blocks must be ordered tools, system, messages`)
  if (problems.length === 0) state.lastBlocks.set(lane, blocks)
  return blocks
}

interface ReadState {
  /** Content by hash, from the first line that carried it. */
  contents: Map<string, unknown>
  /** The blocks of the last full request in each lane, for `request.reuse`. */
  lastBlocks: Map<string, Block[]>
}

/** Identifies the sequence of calls a record is compared within: (session, lane). */
export function laneKey(record: { session?: string; lane?: string }): string {
  return `${record.session ?? ""}\u0000${record.lane ?? "main"}`
}

function readHints(value: unknown, problems: string[], warnings: string[], line: number): Hint[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    problems.push("hints must be an array")
    return undefined
  }
  // Unknown hint kinds are kept: readers ignore what they do not understand.
  return value.filter((hint, index): hint is Hint => {
    if (!isRecord(hint) || typeof hint.kind !== "string") return false
    if (hint.kind !== "prefix_break") return true
    // A malformed declaration is dropped, so the miss it meant to excuse is reported as one rather than hidden.
    const problem =
      typeof hint.reason !== "string" || hint.reason === ""
        ? "needs a non-empty string reason"
        : hint.after !== undefined && !isPosition(hint.after)
          ? 'has an invalid after (use "start", "tools", "system", a block count, or {"message": n})'
          : undefined
    if (problem) warnings.push(`line ${line}: hints[${index}] (prefix_break) ${problem}; ignored`)
    return problem === undefined
  })
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}
