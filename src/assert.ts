// prefixlens/test: prefix-stability assertions for a harness's own tests.
//
// Pure functions, no network. Give them two consecutive requests a harness
// built (request bodies as sent, canonical requests, or trace records) and they
// say whether the second one keeps the first one's cached prefix, and if not,
// which block changed and how.

import { canonicalizeRequest, type CanonicalRequest, type Provider } from "./canonical.ts"
import { comparePrefix, type Cause, type PrefixChange } from "./diff.ts"
import { apiFromBody, PROVIDER_OF } from "./record/exchange.ts"
import type { Block, Hint, TraceRecord } from "./trace.ts"

/**
 * A request to compare: a request body as sent to Anthropic Messages, OpenAI
 * Chat Completions or OpenAI Responses (or Gemini with `provider: "gemini"`);
 * a canonical request (`{ model, params, blocks }`); a trace record; or a
 * bare list of blocks.
 */
export type RequestLike = Record<string, unknown> | TraceRecord | CanonicalRequest | Block[]

/** Where an allowed break may start, as the last part that must stay unchanged. */
export type Position =
  /** Nothing has to stay: the whole request may change. */
  | "start"
  /** The tool list must stay. */
  | "tools"
  /** Tools and system prompt (instructions) must stay. */
  | "system"
  /** Tools, system prompt and messages 1..n must stay. */
  | { message: number }
  /** The first n blocks must stay (blocks are numbered from 1 in messages). */
  | number

export interface PrefixOptions {
  /** Request format, when it cannot be told from the body (always needed for Gemini). */
  provider?: Provider
  /**
   * An intentional breakpoint. The prefix may change after `after` (default:
   * anywhere) because of `reason`, e.g. `{ reason: "compaction" }` or
   * `{ after: "system", reason: "compaction" }` (history may be replaced but
   * the tools and instructions must survive). A plain string is a reason with
   * no position.
   */
  allowBreak?: string | { after?: Position; reason?: string }
  /** Request parameters to leave out of the comparison, e.g. `["tool_choice"]` when your provider does not cache on it. */
  ignoreParams?: string[]
  /** Facts about what happened between the requests (`[{ kind: "compaction" }]`), used to name the change. */
  hints?: Hint[]
}

export interface ChangedBlock {
  /** 1-based block number. */
  number: number
  kind: Block["kind"]
  /** Plain description, e.g. `tool "write_file"`, `system part 1`, `message #3 (assistant)`. */
  label: string
}

export interface PrefixExplanation {
  /** True when `next` keeps every block of `prev` unchanged, in place, with the same model and cache-relevant params. */
  stable: boolean
  /** True when stable, or when the change is allowed by `allowBreak`. */
  ok: boolean
  /** Blocks `next` adds after the unchanged prefix (0 unless stable). */
  appended: number
  /** Leading blocks that are unchanged. */
  unchanged: number
  /** The first change, as the diff engine names it; null when stable. */
  change: PrefixChange | null
  /** The first block that differs, in `prev`'s numbering; absent for model and parameter changes. */
  block?: ChangedBlock
  /** Set when the change was allowed: the reason given in `allowBreak`. */
  allowed?: string
  /** What to do about it. */
  fix?: string
  /** Plain-English explanation; the assertion's failure message. */
  message: string
}

export class PrefixBreakError extends Error {
  override name = "PrefixBreakError"
  constructor(readonly explanation: PrefixExplanation) {
    super(explanation.message)
  }
}

/**
 * Explains how `next` departs from `prev` as a prompt-cache prefix. Never throws
 * for a change; `ok` says whether it is allowed.
 */
export function explainPrefixDiff(prev: RequestLike, next: RequestLike, options: PrefixOptions = {}): PrefixExplanation {
  const before = comparable(prev, options)
  const after = comparable(next, options)
  const allow = typeof options.allowBreak === "string" ? { reason: options.allowBreak } : options.allowBreak
  // A break the caller says is a compaction is named as one, whatever it looks like.
  const hints = [...(options.hints ?? []), ...(allow?.reason === "compaction" ? [{ kind: "compaction" as const }] : [])]
  const change = comparePrefix(before, { ...after, ...(hints.length > 0 ? { hints } : {}) })
  if (!change) {
    const appended = after.blocks.length - before.blocks.length
    return {
      stable: true,
      ok: true,
      appended,
      unchanged: before.blocks.length,
      change: null,
      message: `prefix stable: all ${before.blocks.length} blocks of the previous request are unchanged${appended > 0 ? `, and ${appended} ${plural(appended, "block")} ${appended === 1 ? "was" : "were"} appended` : ""}`,
    }
  }
  const unchanged = change.block_index ?? (change.region === "params" ? before.blocks.findIndex((block) => block.kind === "message") : 0)
  const changedAt = change.region === "model" ? 0 : unchanged === -1 ? before.blocks.length : unchanged
  const keep = allow ? keptBlocks(allow.after ?? "start", before.blocks) : undefined
  const ok = keep !== undefined && changedAt >= keep
  const block = change.block_index === undefined ? undefined : describeBlock(before.blocks, after.blocks, change.block_index)
  const fix = FIXES[change.cause]
  const reason = allow?.reason ?? "an intentional break"
  return {
    stable: false,
    ok,
    appended: 0,
    unchanged: changedAt,
    change,
    ...(block ? { block } : {}),
    ...(ok ? { allowed: reason } : {}),
    ...(fix ? { fix } : {}),
    message: ok
      ? `prefix changed at block ${changedAt + 1}, allowed (${reason}): ${change.summary}`
      : failureMessage(change, before.blocks, changedAt, block, fix, allow && keep !== undefined ? { reason, keep } : undefined),
  }
}

/**
 * Throws a PrefixBreakError, with a message naming the first changed block and
 * what changed, unless `next` keeps `prev`'s prefix (or the change is allowed
 * by `options.allowBreak`). Returns the explanation otherwise.
 */
export function assertPrefixStable(prev: RequestLike, next: RequestLike, options: PrefixOptions = {}): PrefixExplanation {
  const explanation = explainPrefixDiff(prev, next, options)
  if (!explanation.ok) throw new PrefixBreakError(explanation)
  return explanation
}

function failureMessage(change: PrefixChange, blocks: Block[], changedAt: number, block: ChangedBlock | undefined, fix: string | undefined, allowed: { reason: string; keep: number } | undefined): string {
  const where =
    change.region === "model"
      ? "the model changed, so nothing in the cache applies"
      : change.region === "params"
        ? `a cache-relevant request parameter changed (on Anthropic this invalidates every message: ${range(changedAt + 1, blocks.length)})`
        : `first changed block: ${block!.number} of ${blocks.length} (${block!.label}); ${changedAt === 0 ? "nothing before it matches, so the whole request is re-read" : `${range(1, changedAt)} still ${changedAt === 1 ? "matches" : "match"}, everything from block ${changedAt + 1} on is re-read`}`
  const lines = [`prefix not stable: ${change.summary}`, "", `  ${where}`]
  if (allowed) lines.push(`  a break was allowed (${allowed.reason}) only after block ${allowed.keep}, and this one is earlier`)
  if (change.diff) lines.push("", ...clip(change.diff.split("\n"), 16).map((line) => `    ${line}`))
  if (fix) lines.push("", `  fix: ${fix}`)
  if (!allowed) lines.push(`  if this change is intentional, pass { allowBreak: { reason: "..." } }`)
  return lines.join("\n")
}

const FIXES: Partial<Record<Cause, string>> = {
  model_changed: "caches are per model; a model switch always starts cold, so switch only at a deliberate breakpoint.",
  params_changed: "keep cache-relevant parameters fixed for the session, or list the parameter in ignoreParams if your provider does not cache on it.",
  tools_changed: "keep one tool list for the whole session (refuse a disallowed tool when it is called rather than removing it), or change it only at a deliberate breakpoint such as a compaction.",
  tools_reordered: "build the tool list in a deterministic order (sort it once, e.g. by name) instead of connection or map order.",
  tool_definition_changed: "generate tool definitions deterministically: no counts, dates or unordered keys in descriptions and schemas.",
  system_dynamic_value: "keep clocks and ids out of the system prompt: send them in a new message, or round them (to the day, say).",
  system_changed: "freeze the system prompt for the session and append updated instructions as a new message.",
  message_edited: "replay sent messages byte for byte; append a correction as a new message instead of editing history.",
  message_dynamic_value: "replay sent messages byte for byte; a value rendered at send time (a clock, an id) must be stored and replayed, not re-rendered.",
  tool_output_rewritten: "store each tool output once, as sent, and replay it unchanged; truncate before the first send, not on replay.",
  thinking_rewritten: "replay reasoning blocks exactly as the provider returned them.",
  messages_merged: "replay steps with the message boundaries they were sent with.",
  messages_split: "replay steps with the message boundaries they were sent with.",
  messages_reordered: "replay history in the order it was sent.",
  message_inserted: "append new messages at the end; inserting into history moves everything after it.",
  message_removed: "do not drop sent messages; if this was a deliberate compaction or rewind, mark it with allowBreak.",
  history_truncated: "if this was a deliberate compaction or rewind, mark it with allowBreak.",
  history_rewound: "if this was a deliberate rewind, mark it with allowBreak.",
  compaction: "a compaction always breaks the prefix; mark it with { allowBreak: { reason: \"compaction\" } }.",
}

function comparable(value: RequestLike, options: PrefixOptions) {
  const ignore = (params: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => !options.ignoreParams?.includes(key)))
  if (Array.isArray(value)) return { model: "", params: {}, blocks: value }
  const body = value as Record<string, unknown>
  if (Array.isArray(body.blocks)) return { model: String(body.model ?? ""), params: ignore(body.params as Record<string, unknown>), blocks: body.blocks as Block[] }
  const record = value as Partial<TraceRecord>
  if (record.v === 1 && typeof record.fidelity === "string") {
    if (!record.request) throw new TypeError("prefixlens/test: a usage-only trace record has no request to compare")
    return { model: record.model ?? "", params: ignore(record.params), blocks: record.request.blocks }
  }
  const provider = options.provider ?? PROVIDER_OF[apiFromBody(body)]
  const canonical = canonicalizeRequest(provider, body)
  return { model: canonical.model, params: ignore(canonical.params), blocks: canonical.blocks }
}

function keptBlocks(position: Position, blocks: Block[]): number {
  if (position === "start") return 0
  if (typeof position === "number") return position
  const lastOf = (kinds: Block["kind"][]) => blocks.findLastIndex((block) => kinds.includes(block.kind)) + 1
  if (position === "tools") return lastOf(["tool"])
  if (position === "system") return lastOf(["tool", "system"])
  const firstMessage = blocks.findIndex((block) => block.kind === "message")
  return (firstMessage === -1 ? blocks.length : firstMessage) + position.message
}

function describeBlock(prev: Block[], next: Block[], index: number): ChangedBlock {
  const was = prev[index] ? labelOf(prev, index) : undefined
  const now = next[index] ? labelOf(next, index) : undefined
  const label = !was ? `${now}, added` : !now ? `${was}, removed` : was === now ? was : `${was}, now ${now}`
  return { number: index + 1, kind: (prev[index] ?? next[index])!.kind, label }
}

function labelOf(blocks: Block[], index: number): string {
  const block = blocks[index]!
  const position = blocks.slice(0, index + 1).filter((candidate) => candidate.kind === block.kind).length
  if (block.kind === "tool") return block.key ? `tool "${block.key}"` : `tool #${position}`
  if (block.kind === "system") return `system part ${position}`
  return `message #${position}${block.key ? `, ${block.key}` : ""}`
}

function range(from: number, to: number) {
  return from >= to ? `block ${from}` : `blocks ${from}-${to}`
}

function clip(lines: string[], max: number): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max), `… ${lines.length - max} more lines`]
}

function plural(count: number, word: string) {
  return count === 1 ? word : `${word}s`
}

