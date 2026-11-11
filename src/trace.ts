// Trace format: one JSON object per line, one line per model call. SPEC.md is
// the normative description; this file is its TypeScript form plus a reader
// that validates records once at the boundary.

import { hashContent, isRecord } from "./canonical.ts"

export const TRACE_VERSION = 1

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

export interface Hint {
  kind: HintKind
  detail?: string
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
  const compact = options.compact ?? true
  const written = new Set<string>()
  const last = new Map<string, Block[]>()
  const lines = records.map((record) => {
    if (!compact || !record.request) return JSON.stringify(record)
    const all = record.request.blocks
    const lane = laneKey(record)
    const previous = last.get(lane) ?? []
    last.set(lane, all)
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
    for (const block of all.slice(0, reuse)) written.add(block.hash)
    return JSON.stringify({ ...record, request: { ...(reuse > 0 ? { reuse } : {}), blocks } })
  })
  return lines.join("\n") + (lines.length > 0 ? "\n" : "")
}

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
  if (value.cache_ttl_seconds !== undefined && !isCount(value.cache_ttl_seconds))
    problems.push("cache_ttl_seconds must be a non-negative integer")
  const usage = readUsage(value.usage, problems)
  const lane = laneKey({ session: typeof value.session === "string" ? value.session : undefined, lane: typeof value.lane === "string" ? value.lane : undefined })
  const blocks = value.fidelity === "full-request" && problems.length === 0 ? readBlocks(value.request, problems, warnings, line, state, lane) : undefined
  const hints = readHints(value.hints, problems)
  if (problems.length > 0) return undefined
  return {
    ...(value as unknown as TraceRecord),
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

function readHints(value: unknown, problems: string[]): Hint[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    problems.push("hints must be an array")
    return undefined
  }
  // Unknown hint kinds are kept: readers ignore what they do not understand.
  return value.filter((hint): hint is Hint => isRecord(hint) && typeof hint.kind === "string")
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}
