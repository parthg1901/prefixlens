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
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return
    const parsed = parseJson(line)
    if (parsed === undefined) return errors.push(`line ${index + 1}: not valid JSON`)
    const problems: string[] = []
    const record = readRecord(parsed, problems, warnings, index + 1)
    if (problems.length > 0) return errors.push(...problems.map((problem) => `line ${index + 1}: ${problem}`))
    records.push(record!)
  })
  return { records, errors, warnings }
}

export function serializeTrace(records: TraceRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "")
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function readRecord(value: unknown, problems: string[], warnings: string[], line: number): TraceRecord | undefined {
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
  const blocks = value.fidelity === "full-request" ? readBlocks(value.request, problems, warnings, line) : undefined
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

function readBlocks(value: unknown, problems: string[], warnings: string[], line: number): Block[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.blocks)) {
    problems.push("request.blocks must be an array when fidelity is full-request")
    return undefined
  }
  const order: Record<BlockKind, number> = { tool: 0, system: 1, message: 2 }
  let previous = 0
  return value.blocks.flatMap((block, index): Block[] => {
    if (!isRecord(block) || !(block.kind === "tool" || block.kind === "system" || block.kind === "message")) {
      problems.push(`request.blocks[${index}].kind must be "tool", "system" or "message"`)
      return []
    }
    if (order[block.kind] < previous) problems.push(`request.blocks[${index}]: blocks must be ordered tools, system, messages`)
    previous = order[block.kind]
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
    return [{ ...(block as unknown as Block), hash }]
  })
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
