// Diff engine: compares two requests block by block in prefix order, finds the
// first block that changed, and names the change in plain words.

import { canonicalJson, hashContent, isRecord } from "./canonical.ts"
import { IDENTIFYING_PARAMS, paramRule, type InvalidatesFrom } from "./params.ts"
import { changedSpan, flatten, renderDiff } from "./textdiff.ts"
import type { Block, Hint } from "./trace.ts"

export type Cause =
  | "cold_start"
  | "model_changed"
  | "params_changed"
  | "tools_changed"
  | "tools_reordered"
  | "tool_definition_changed"
  | "system_changed"
  | "system_dynamic_value"
  | "compaction"
  | "history_truncated"
  | "history_rewound"
  | "message_edited"
  | "message_dynamic_value"
  | "tool_output_rewritten"
  | "thinking_rewritten"
  | "message_inserted"
  | "message_removed"
  | "messages_reordered"
  | "messages_merged"
  | "messages_split"
  | "cache_expired"
  | "provider_side"
  | "unknown"

export type CauseGroup =
  | "cold start"
  | "model or parameter changes"
  | "tool-list changes"
  | "system-prompt changes"
  | "history rewrites"
  | "reshaped steps"
  | "compaction"
  | "cache expiry"
  | "provider-side misses"
  | "unknown causes"

export const CAUSE_GROUP: Record<Cause, CauseGroup> = {
  cold_start: "cold start",
  model_changed: "model or parameter changes",
  params_changed: "model or parameter changes",
  tools_changed: "tool-list changes",
  tools_reordered: "tool-list changes",
  tool_definition_changed: "tool-list changes",
  system_changed: "system-prompt changes",
  system_dynamic_value: "system-prompt changes",
  compaction: "compaction",
  history_truncated: "history rewrites",
  history_rewound: "history rewrites",
  message_edited: "history rewrites",
  message_dynamic_value: "history rewrites",
  tool_output_rewritten: "history rewrites",
  thinking_rewritten: "history rewrites",
  message_inserted: "history rewrites",
  message_removed: "history rewrites",
  messages_reordered: "history rewrites",
  messages_merged: "reshaped steps",
  messages_split: "reshaped steps",
  cache_expired: "cache expiry",
  provider_side: "provider-side misses",
  unknown: "unknown causes",
}

export type Region = "model" | "params" | "tools" | "system" | "messages"

export interface PrefixChange {
  cause: Cause
  /** Plain-English description, e.g. "tool list changed (+2 tools)". */
  summary: string
  region: Region
  /** Index into the request blocks of the first block that differs. */
  block_index?: number
  detail: Record<string, unknown>
  /** Small text diff of the first changed block (or params), when content is available. */
  diff?: string
}

export interface Comparable {
  /** Whose caching rules apply to params (SPEC 8.1). Unknown or absent: the rules common to every provider. */
  provider?: string
  model: string
  params?: Record<string, unknown>
  blocks: Block[]
  hints?: Hint[]
}

/**
 * Parameters no provider caches on (sampling, output limits, bookkeeping).
 * @deprecated The comparison is per provider now; see `paramRule` and
 * `PARAM_RULES` in params.ts. Kept as the provider-independent part of that table.
 */
export const PARAMS_IGNORED = new Set([
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop",
  "stop_sequences",
  "metadata",
  "user",
  "n",
  "stream",
  "stream_options",
])

/**
 * Index of the first block of `prev` whose hash differs from the block at the
 * same position in `next`, or -1 when `prev` is an unchanged prefix of `next`.
 */
export function firstDivergence(prev: Block[], next: Block[]): number {
  for (let index = 0; index < prev.length; index++) if (prev[index]!.hash !== next[index]?.hash) return index
  return -1
}

/**
 * Explains how `next` departs from `prev` as a prompt prefix. Returns null
 * when the model and cache-relevant params match and every block of `prev`
 * reappears unchanged at the start of `next`.
 *
 * Changes are reported in invalidation order: the model, then tools and the
 * system prompt, then params, then messages.
 */
export function comparePrefix(prev: Comparable, next: Comparable): PrefixChange | null {
  if (prev.model !== next.model)
    return {
      cause: "model_changed",
      summary: `model changed (${prev.model} → ${next.model}); caches are per model`,
      region: "model",
      detail: { from: prev.model, to: next.model },
    }
  const index = firstDivergence(prev.blocks, next.blocks)
  const region = index === -1 ? undefined : regionAt(prev.blocks, next.blocks, index)
  if (region === "tools") return { ...explainTools(prev.blocks, next.blocks), block_index: index }
  if (region === "system") return { ...explainSystem(prev.blocks, next.blocks), block_index: index }
  const provider = next.provider ?? prev.provider
  const params = changedParams(prev.params ?? {}, next.params ?? {}, provider)
  if (params.length > 0) {
    const rules = Object.fromEntries(params.map((key) => [key, paramRule(provider, key)]))
    // Several changed params invalidate from the earliest part any of them reaches.
    const order: InvalidatesFrom[] = ["start", "system", "messages"]
    const from = order.find((level) => params.some((key) => rules[key]!.from === level)) ?? "start"
    return {
      cause: "params_changed",
      summary: `request parameters changed: ${params.join(", ")}`,
      region: "params",
      detail: { keys: params, from, evidence: Object.fromEntries(params.map((key) => [key, rules[key]!.evidence])) },
      diff: renderDiff(pick(prev.params ?? {}, params), pick(next.params ?? {}, params)),
    }
  }
  if (region === "messages") return { ...explainMessages(prev, next, index), block_index: index }
  return null
}

function regionAt(prev: Block[], next: Block[], index: number): Region {
  const kinds = [prev[index]?.kind, next[index]?.kind]
  if (kinds.includes("tool")) return "tools"
  if (kinds.includes("system")) return "system"
  return "messages"
}

function explainTools(prevBlocks: Block[], nextBlocks: Block[]): PrefixChange {
  const prev = prevBlocks.filter((block) => block.kind === "tool")
  const next = nextBlocks.filter((block) => block.kind === "tool")
  const name = (block: Block, index: number) => block.key ?? `tool #${index + 1}`
  const prevNames = prev.map(name)
  const nextNames = next.map(name)
  const added = nextNames.filter((tool) => !prevNames.includes(tool))
  const removed = prevNames.filter((tool) => !nextNames.includes(tool))
  if (added.length > 0 || removed.length > 0) {
    const counts = [added.length > 0 ? `+${added.length}` : "", removed.length > 0 ? `-${removed.length}` : ""]
      .filter(Boolean)
      .join(" ")
    return {
      cause: "tools_changed",
      summary: `tool list changed (${counts} ${plural(added.length + removed.length, "tool")}: ${prev.length} → ${next.length})`,
      region: "tools",
      detail: { added, removed, before: prev.length, after: next.length },
      diff: [...removed.map((tool) => `- ${tool}`), ...added.map((tool) => `+ ${tool}`)].slice(0, 24).join("\n"),
    }
  }
  const sameDefinitions = sameMultiset(prev.map((block) => block.hash), next.map((block) => block.hash))
  if (sameDefinitions) {
    const moved = prevNames.filter((tool, index) => nextNames[index] !== tool)
    return {
      cause: "tools_reordered",
      summary: `tool order changed (${moved.length} of ${prev.length} tools moved; same tools, different order)`,
      region: "tools",
      detail: { moved, before: prevNames, after: nextNames },
      diff: renderDiff(prevNames, nextNames),
    }
  }
  const changed = prev.flatMap((block, index) => {
    const match = next.find((candidate, candidateIndex) => name(candidate, candidateIndex) === name(block, index))
    return match && match.hash !== block.hash ? [{ name: name(block, index), before: block, after: match }] : []
  })
  const first = changed[0]
  return {
    cause: "tool_definition_changed",
    summary: `tool definition changed: ${changed.map((tool) => tool.name).join(", ") || "unknown tool"}`,
    region: "tools",
    detail: { changed: changed.map((tool) => tool.name), order_changed: !sameOrder(prevNames, nextNames) },
    ...(first ? diffOf(first.before, first.after) : {}),
  }
}

function explainSystem(prevBlocks: Block[], nextBlocks: Block[]): PrefixChange {
  const prev = prevBlocks.filter((block) => block.kind === "system")
  const next = nextBlocks.filter((block) => block.kind === "system")
  const index = prev.findIndex((block, position) => block.hash !== next[position]?.hash)
  const position = index === -1 ? prev.length : index
  const before = prev[position]
  const after = next[position]
  if (!before || !after)
    return {
      cause: "system_changed",
      summary: `system prompt changed (${prev.length} → ${next.length} parts)`,
      region: "system",
      detail: { part: position + 1, before_parts: prev.length, after_parts: next.length },
      ...(before ? diffOf(before, { kind: "system", hash: "" }) : after ? diffOf({ kind: "system", hash: "" }, after) : {}),
    }
  const dynamic = dynamicValue(before, after)
  return {
    cause: dynamic ? "system_dynamic_value" : "system_changed",
    summary: dynamic
      ? `system prompt changed: a ${dynamic} value was updated (${quoteShort(dynamicSpan(before, after))})`
      : `system prompt changed (part ${position + 1} of ${next.length} edited)`,
    region: "system",
    detail: { part: position + 1, ...(dynamic ? { dynamic } : {}) },
    ...diffOf(before, after),
  }
}

function explainMessages(prev: Comparable, next: Comparable, blockIndex: number): PrefixChange {
  const prevMessages = prev.blocks.filter((block) => block.kind === "message")
  const nextMessages = next.blocks.filter((block) => block.kind === "message")
  const firstMessage = prev.blocks.findIndex((block) => block.kind === "message")
  const index = blockIndex - firstMessage
  const position = index + 1
  const prevHashes = prevMessages.map((block) => block.hash)
  const nextHashes = nextMessages.map((block) => block.hash)
  const before = prevMessages[index]!
  const after = nextMessages[index]
  const compactionHint = next.hints?.some((hint) => hint.kind === "compaction")

  if (!after)
    return {
      cause: "history_truncated",
      summary: `history truncated: ${prevMessages.length - nextMessages.length} trailing ${plural(prevMessages.length - nextMessages.length, "message")} dropped`,
      region: "messages",
      detail: { message: position, before: prevMessages.length, after: nextMessages.length },
    }
  if (compactionHint || isCompaction(prevHashes, nextHashes, index))
    return {
      cause: "compaction",
      summary: `history compacted (${prevMessages.length} → ${nextMessages.length} messages from message #${position})`,
      region: "messages",
      detail: { message: position, before: prevMessages.length, after: nextMessages.length },
    }
  if (nextHashes[index] === prevHashes[index + 1] && aligned(prevHashes, index + 1, nextHashes, index))
    return {
      cause: "message_removed",
      summary: `message #${position} (${before.key ?? "message"}) removed from history`,
      region: "messages",
      detail: { message: position, role: before.key },
      ...diffOf(before, { kind: "message", hash: "" }),
    }
  if (nextHashes[index + 1] === prevHashes[index] && aligned(prevHashes, index, nextHashes, index + 1))
    return {
      cause: "message_inserted",
      summary: `a message (${after.key ?? "message"}) was inserted into history before message #${position}`,
      region: "messages",
      detail: { message: position, role: after.key },
      ...diffOf({ kind: "message", hash: "" }, after),
    }
  if (isRewind(prevHashes, nextHashes, index))
    return {
      cause: "history_rewound",
      summary: `conversation rewound at message #${position}: the ${prevMessages.length - index} messages from there were replaced (rewind or edited prompt)`,
      region: "messages",
      detail: { message: position, replaced: prevMessages.length - index, before: prevMessages.length, after: nextMessages.length },
      ...diffOf(before, after),
    }
  const reordered = reorderWindow(prevHashes, nextHashes, index)
  if (reordered)
    return {
      cause: "messages_reordered",
      summary: `messages #${position}-#${position + reordered - 1} reordered`,
      region: "messages",
      detail: { message: position, count: reordered },
    }
  const reshaped = reshape(prevMessages, nextMessages, index)
  if (reshaped) return reshaped
  return explainEdit(before, after, position)
}

function explainEdit(before: Block, after: Block, position: number): PrefixChange {
  const role = after.key ?? before.key ?? "message"
  const base = { region: "messages" as const, ...diffOf(before, after) }
  if (before.content === undefined || after.content === undefined)
    return { ...base, cause: "message_edited", summary: `message #${position} (${role}) changed (content not recorded)`, detail: { message: position, role } }
  const changed = changedParts(before.content, after.content)
  const kinds = new Set(changed.map((part) => part.kind))
  if (changed.length > 0 && [...kinds].every((kind) => kind === "tool_result")) {
    const sizeBefore = changed.reduce((sum, part) => sum + part.sizeBefore, 0)
    const sizeAfter = changed.reduce((sum, part) => sum + part.sizeAfter, 0)
    const direction = sizeAfter < sizeBefore ? "truncated" : sizeAfter > sizeBefore ? "expanded" : "rewritten"
    return {
      ...base,
      cause: "tool_output_rewritten",
      summary: `tool output in message #${position} ${direction} after it was sent (${number(sizeBefore)} → ${number(sizeAfter)} chars)`,
      detail: { message: position, role, direction, chars_before: sizeBefore, chars_after: sizeAfter, parts: changed.length },
    }
  }
  if (changed.length > 0 && [...kinds].every((kind) => kind === "thinking"))
    return {
      ...base,
      cause: "thinking_rewritten",
      summary: `reasoning blocks in message #${position} were changed or dropped on replay`,
      detail: { message: position, role, parts: changed.length },
    }
  const dynamic = dynamicValue(before, after)
  if (dynamic)
    return {
      ...base,
      cause: "message_dynamic_value",
      summary: `message #${position} (${role}) edited: a ${dynamic} value was updated (${quoteShort(dynamicSpan(before, after))})`,
      detail: { message: position, role, dynamic },
    }
  const added = changed.filter((part) => part.sizeBefore === 0).length
  const removed = changed.filter((part) => part.sizeAfter === 0).length
  const how =
    changed.length > 0 && added === changed.length
      ? `: ${added} ${plural(added, "part")} appended`
      : changed.length > 0 && removed === changed.length
        ? `: ${removed} ${plural(removed, "part")} removed`
        : ""
  return {
    ...base,
    cause: "message_edited",
    summary: `message #${position} (${role}) was edited after it was sent${how}`,
    detail: { message: position, role, parts_added: added, parts_removed: removed },
  }
}

// History was replaced rather than edited in place: few of the old messages
// after the divergence survive anywhere in the next request.
function replaced(prev: string[], next: string[], index: number): boolean {
  const survivors = new Set(next.slice(index))
  const kept = prev.slice(index).filter((hash) => survivors.has(hash)).length
  return kept <= Math.max(1, Math.floor((prev.length - index) / 4))
}

// Compaction replaces most of the conversation with something shorter.
function isCompaction(prev: string[], next: string[], index: number): boolean {
  const lost = prev.length - index
  return next.length < prev.length - 1 && lost >= Math.max(4, prev.length / 2) && replaced(prev, next, index)
}

// A rewind keeps the early conversation and replaces a later stretch of several messages.
function isRewind(prev: string[], next: string[], index: number): boolean {
  return prev.length - index >= 3 && next.length < prev.length && replaced(prev, next, index)
}

function aligned(a: string[], fromA: number, b: string[], fromB: number): boolean {
  const length = Math.min(a.length - fromA, b.length - fromB, 3)
  for (let offset = 0; offset < length; offset++) if (a[fromA + offset] !== b[fromB + offset]) return false
  return true
}

function reorderWindow(prev: string[], next: string[], index: number): number | undefined {
  for (let size = 2; size <= 6; size++) {
    const a = prev.slice(index, index + size)
    const b = next.slice(index, index + size)
    if (a.length < size || b.length < size) return undefined
    if (sameMultiset(a, b)) return size
  }
  return undefined
}

function reshape(prev: Block[], next: Block[], index: number): PrefixChange | undefined {
  const parts = (block: Block | undefined) =>
    block && isRecord(block.content) && Array.isArray(block.content.content)
      ? block.content.content.map((part) => hashContent(part))
      : undefined
  const role = (block: Block | undefined) => block?.key
  const a = parts(prev[index])
  const a2 = parts(prev[index + 1])
  const b = parts(next[index])
  const b2 = parts(next[index + 1])
  const position = index + 1
  if (a && a2 && b && role(prev[index]) === role(prev[index + 1]) && sameOrder([...a, ...a2], b))
    return {
      cause: "messages_merged",
      summary: `steps reshaped: messages #${position} and #${position + 1} (${role(prev[index]) ?? "message"}) were merged into one`,
      region: "messages",
      detail: { message: position, role: role(prev[index]) },
    }
  if (a && b && b2 && role(next[index]) === role(next[index + 1]) && sameOrder(a, [...b, ...b2]))
    return {
      cause: "messages_split",
      summary: `steps reshaped: message #${position} (${role(prev[index]) ?? "message"}) was split into two`,
      region: "messages",
      detail: { message: position, role: role(prev[index]) },
    }
  return undefined
}

type PartKind = "tool_result" | "thinking" | "other"

function changedParts(before: unknown, after: unknown) {
  const list = (content: unknown): unknown[] =>
    isRecord(content) && Array.isArray(content.content) ? content.content : isRecord(content) && Array.isArray(content.parts) ? content.parts : [content]
  const kindOf = (message: unknown, part: unknown): PartKind => {
    const type = isRecord(part) ? part.type : undefined
    if (type === "tool_result" || type === "function_call_output" || (isRecord(part) && "functionResponse" in part)) return "tool_result"
    if (isRecord(message) && message.role === "tool") return "tool_result"
    if (type === "thinking" || type === "redacted_thinking" || type === "reasoning") return "thinking"
    return "other"
  }
  // OpenAI tool messages carry the output in the message body itself.
  if (isRecord(before) && before.role === "tool" && isRecord(after) && after.role === "tool")
    return [{ kind: "tool_result" as PartKind, sizeBefore: textSize(before.content), sizeAfter: textSize(after.content) }]
  // Compare parts as sets so a dropped part reads as one removal, not as every later part shifting.
  const a = list(before)
  const b = list(after)
  const keysA = new Set(a.map((part) => canonicalJson(part)))
  const keysB = new Set(b.map((part) => canonicalJson(part)))
  const removed = a.filter((part) => !keysB.has(canonicalJson(part)))
  const added = b.filter((part) => !keysA.has(canonicalJson(part)))
  return [
    ...removed.map((part) => ({ kind: kindOf(before, part), sizeBefore: textSize(part), sizeAfter: 0 })),
    ...added.map((part) => ({ kind: kindOf(after, part), sizeBefore: 0, sizeAfter: textSize(part) })),
  ]
}

function textSize(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value === "string") return value.length
  if (isRecord(value) && value.type === "tool_result") return textSize(value.content)
  if (isRecord(value) && typeof value.text === "string") return value.text.length
  if (isRecord(value) && typeof value.output === "string") return value.output.length
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + textSize(item), 0)
  return canonicalJson(value).length
}

const DYNAMIC_PATTERNS: [string, RegExp][] = [
  ["timestamp", /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(:\d{2})?|^\d{10,13}$/],
  ["date", /\b(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i],
  ["unique id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b/i],
]

/**
 * When the only difference between two blocks is a short span that looks like
 * a clock reading or a fresh identifier, names what kind of value it was.
 */
function dynamicValue(before: Block, after: Block): string | undefined {
  if (before.content === undefined || after.content === undefined) return undefined
  const span = spanAround(flatten(before.content).join("\n"), flatten(after.content).join("\n"))
  if (span.a.length > 64 || span.b.length > 64) return undefined
  for (const [label, pattern] of DYNAMIC_PATTERNS) if (pattern.test(span.a) && pattern.test(span.b)) return label
  return undefined
}

function dynamicSpan(before: Block, after: Block): string {
  const span = spanAround(flatten(before.content).join("\n"), flatten(after.content).join("\n"))
  return `${span.a} → ${span.b}`
}

// The changed span widened to whole tokens, so "10:41" vs "10:42" reads as a time, not "1" vs "2".
function spanAround(a: string, b: string) {
  const span = changedSpan(a, b)
  const token = /[\w:.\-\/+]/
  let start = span.start
  while (start > 0 && token.test(a[start - 1]!)) start--
  let endA = span.endA
  let endB = span.endB
  while (endA < a.length && endB < b.length && token.test(a[endA]!) && a[endA] === b[endB]) {
    endA++
    endB++
  }
  const trim = (text: string) => text.replace(/[.,:;]+$/, "")
  return { a: trim(a.slice(start, endA)), b: trim(b.slice(start, endB)) }
}

function changedParams(prev: Record<string, unknown>, next: Record<string, unknown>, provider: string | undefined): string[] {
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((key) => paramRule(provider, key).effect === "prefix")
  // Identifying fields are left out of records by default, so one missing on either side is unknown, not changed.
  const known = keys.filter((key) => !IDENTIFYING_PARAMS.includes(key) || (key in prev && key in next))
  return known.filter((key) => canonicalJson(prev[key] ?? null) !== canonicalJson(next[key] ?? null)).sort()
}

function pick(object: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, object[key] ?? null]))
}

function diffOf(before: Block, after: Block): { diff?: string } {
  if (before.content === undefined && after.content === undefined) return {}
  const diff = renderDiff(before.content ?? null, after.content ?? null)
  return diff === "" ? {} : { diff }
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const counts = new Map<string, number>()
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1)
  for (const item of b) {
    const left = counts.get(item) ?? 0
    if (left === 0) return false
    counts.set(item, left - 1)
  }
  return true
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

function number(value: number): string {
  return value.toLocaleString("en-US")
}

function quoteShort(text: string): string {
  return text.length <= 70 ? text : `${text.slice(0, 69)}…`
}
