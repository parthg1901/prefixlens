// Diff engine: compares two requests block by block in prefix order, finds the
// first block that changed, and names the change in plain words.

import { canonicalJson, hashContent, isItemReference, isRecord } from "./canonical.ts"
import { IDENTIFYING_PARAMS, paramRule, type InvalidatesFrom } from "./params.ts"
import { changedSpan, flatten, renderDiff } from "./textdiff.ts"
import { prefixBlocks, type Block, type Hint } from "./trace.ts"

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
  | "oldest_messages_removed"
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
  oldest_messages_removed: "history rewrites",
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
  /** Index of the first block that differs, into the request's prefix blocks (every block but deferred tools: `prefixBlocks`). */
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
 * system prompt, then params, then messages. Deferred tools are not part of the
 * prefix and are left out on both sides.
 */
export function comparePrefix(before: Comparable, after: Comparable): PrefixChange | null {
  const prev = { ...before, blocks: prefixBlocks(before.blocks) }
  const next = { ...after, blocks: prefixBlocks(after.blocks) }
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
      ? `system prompt changed: a ${dynamic.label} value was updated (${quoteShort(`${dynamic.from} → ${dynamic.to}`)})`
      : `system prompt changed (part ${position + 1} of ${next.length} edited)`,
    region: "system",
    detail: { part: position + 1, ...(dynamic ? { dynamic: dynamic.label } : {}) },
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
  const compacted = (kept?: number): PrefixChange => ({
    cause: "compaction",
    summary: `history compacted (${prevMessages.length} → ${nextMessages.length} messages from message #${position})`,
    region: "messages",
    detail: { message: position, before: prevMessages.length, after: nextMessages.length, ...(kept === undefined ? {} : { kept }) },
  })
  if (compactionHint) return compacted()
  // A sliding window: nothing new in front, the oldest messages gone, everything after them replayed as it was.
  const dropped = index === 0 ? droppedFromStart(prevHashes, nextHashes) : 0
  if (dropped > 0) {
    const kept = prevMessages.length - dropped
    return {
      cause: "oldest_messages_removed",
      summary: `${dropped} oldest ${plural(dropped, "message")} removed from the start of history (${kept} kept, ${nextMessages.length - kept} appended)`,
      region: "messages",
      detail: { message: position, removed: dropped, kept, before: prevMessages.length, after: nextMessages.length },
    }
  }
  if (isCompaction(prevHashes, nextHashes, index)) return compacted()
  // A compaction that keeps recent messages: new ones in front, then the old history from a later message on. Two
  // messages merged into one have the same outline and are named below.
  const tail = keptTail(prevHashes, nextHashes, index)
  if (tail !== undefined && !reshape(prevMessages, nextMessages, index)) return compacted(tail)
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
  // Two references differ only in the stored item they name; nothing of either item is in the request.
  if (isItemReference(before) && isItemReference(after) && isRecord(before.content) && isRecord(after.content))
    return {
      ...base,
      cause: "message_edited",
      summary: `message #${position} refers to another stored item (item_reference ${String(before.content.id)} → ${String(after.content.id)}); references are compared by id only`,
      detail: { message: position, role, reference: true },
    }
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
  const binary = binaryChange(before, after)
  if (binary)
    return {
      ...base,
      cause: "message_edited",
      summary: `message #${position} (${role}) edited: ${binary}`,
      detail: { message: position, role, binary: true },
    }
  // Parts put ahead of parts already sent: what a message inserted into history looks like once the SDK or the
  // provider has merged it with the message after it (consecutive user messages are sent as one).
  const ahead = partsAhead(before.content, after.content)
  if (ahead)
    return {
      ...base,
      cause: "message_inserted",
      summary: `${ahead.count} ${plural(ahead.count, "part")} inserted ${ahead.leading ? "at the start of" : "into"} message #${position} (${role}), ahead of content already sent; a message inserted before it and merged into it looks like this`,
      detail: { message: position, role, parts_added: ahead.count, at: ahead.leading ? "start" : "middle" },
    }
  const dynamic = dynamicValue(before, after)
  if (dynamic)
    return {
      ...base,
      cause: "message_dynamic_value",
      summary: `message #${position} (${role}) edited: a ${dynamic.label} value was updated (${quoteShort(`${dynamic.from} → ${dynamic.to}`)})`,
      detail: { message: position, role, dynamic: dynamic.label },
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

/**
 * How many of the oldest messages were removed, when that is all that happened to the history that
 * was sent: every message after them is replayed unchanged and in order, with nothing put in front
 * (anything new comes after). 0 otherwise.
 */
function droppedFromStart(prev: string[], next: string[]): number {
  for (let count = 1; count < prev.length; count++) {
    if (prev.length - count > next.length) continue
    if (prev.every((hash, position) => position < count || next[position - count] === hash)) return count
  }
  return 0
}

/**
 * The number of old messages a compaction kept word for word, when `next` replaces the messages
 * from `index` on with fewer new ones and then replays the rest of the old history unchanged and in
 * order: a summary in front, the recent tail after it, however long that tail is. Undefined when
 * the history does not have that outline.
 */
function keptTail(prev: string[], next: string[], index: number): number | undefined {
  const old = new Set(prev)
  for (let from = index + 2; from < prev.length; from++) {
    const at = next.indexOf(prev[from]!, index + 1)
    if (at === -1 || at - index >= from - index) continue
    const replayed = prev.every((hash, position) => position < from || next[at + position - from] === hash)
    if (replayed && next.slice(index, at).every((hash) => !old.has(hash))) return prev.length - from
  }
  return undefined
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

// The parts of a message: its `content` array (Gemini: `parts`), else the message itself as one part.
function partList(content: unknown): unknown[] {
  return isRecord(content) && Array.isArray(content.content) ? content.content : isRecord(content) && Array.isArray(content.parts) ? content.parts : [content]
}

/**
 * When a message kept every part it was sent with and gained new ones placed before at least one of
 * them: how many, and whether they all come before the first part already sent. Undefined when a
 * part was removed or changed, or when the new parts only follow the old ones (an append).
 */
function partsAhead(before: unknown, after: unknown): { count: number; leading: boolean } | undefined {
  const old = new Set(partList(before).map((part) => canonicalJson(part)))
  const kept = partList(after).map((part) => old.has(canonicalJson(part)))
  if (kept.filter(Boolean).length !== old.size || partList(before).length !== old.size) return undefined
  const count = kept.slice(0, kept.lastIndexOf(true)).filter((sent) => !sent).length
  return count === 0 ? undefined : { count, leading: kept.indexOf(true) === count }
}

function changedParts(before: unknown, after: unknown) {
  const list = partList
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
  ["relative date", /^(today|yesterday|tomorrow|tonight|(this|last|next) (morning|afternoon|evening|night|week|month|year))$/i],
]

// A relative date or time rendered again later: "2 hours ago", "in 3 days", "a week ago".
const RELATIVE_UNIT = "(?:second|minute|hour|day|week|month|year)s?"
const RELATIVE_COUNT = "(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a few|several)"
const RELATIVE_PHRASE = new RegExp(`\\b${RELATIVE_COUNT} ${RELATIVE_UNIT} ago\\b|\\bin ${RELATIVE_COUNT} ${RELATIVE_UNIT}\\b`, "gi")

const BINARY_MARKER = /<binary (?:([^,>]+), )?(\d+) bytes, sha256 ([0-9a-f]{64})>/g

/** When the blocks differ only in elided binary data (SPEC 4.5): which part changed, by media type and digest. */
function binaryChange(before: Block, after: Block): string | undefined {
  if (!before.elided && !after.elided) return undefined
  const text = (block: Block) => flatten(block.content).join("\n")
  const [a, b] = [text(before), text(after)]
  if (a.replace(BINARY_MARKER, "<binary>") !== b.replace(BINARY_MARKER, "<binary>")) return undefined
  const markers = (value: string) => [...value.matchAll(BINARY_MARKER)]
  const [old, now] = [markers(a), markers(b)]
  const index = old.findIndex((marker, position) => marker[0] !== now[position]?.[0])
  if (index === -1) return undefined
  const [from, to] = [old[index]!, now[index]!]
  return `binary part ${index + 1} changed (${to[1] ?? "data"}, ${number(Number(from[2]))} → ${number(Number(to[2]))} bytes, sha256 ${from[3]!.slice(0, 12)} → ${to[3]!.slice(0, 12)})`
}

/**
 * When the only difference between two blocks is a short span that looks like
 * a clock reading, a date (absolute or relative) or a fresh identifier: what
 * kind of value it was, and the value before and after.
 */
function dynamicValue(before: Block, after: Block): { label: string; from: string; to: string } | undefined {
  if (before.content === undefined || after.content === undefined) return undefined
  const span = spanAround(flatten(before.content).join("\n"), flatten(after.content).join("\n"))
  if (span.a.length > 64 || span.b.length > 64) return undefined
  for (const [label, pattern] of DYNAMIC_PATTERNS) if (pattern.test(span.a) && pattern.test(span.b)) return { label, from: span.a, to: span.b }
  // "2 hours ago" and "3 hours ago" differ in one digit: the phrase around the changed span says what it is.
  const from = phraseAt(span.lead + span.a + span.trail, span.lead.length, span.a.length)
  const to = phraseAt(span.lead + span.b + span.trail, span.lead.length, span.b.length)
  return from !== undefined && to !== undefined ? { label: "relative date", from, to } : undefined
}

// The relative-date phrase in `text` that covers the changed span starting at `start`, if there is one.
function phraseAt(text: string, start: number, length: number): string | undefined {
  for (const match of text.matchAll(RELATIVE_PHRASE)) if (match.index <= start && match.index + match[0].length >= start + length) return match[0]
  return undefined
}

// The changed span widened to whole tokens, so "10:41" vs "10:42" reads as a time, not "1" vs "2",
// with the few words on either side of it (the same in both texts).
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
  const [wordA, wordB] = [trim(a.slice(start, endA)), trim(b.slice(start, endB))]
  return { a: wordA, b: wordB, lead: a.slice(Math.max(0, start - 12), start), trail: a.slice(start + wordA.length, start + wordA.length + 24) }
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
