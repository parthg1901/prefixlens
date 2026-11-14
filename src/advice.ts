// Words the assertions and `prefixlens check` share: how a changed block is
// named, and what to do about each cause.

import type { Cause } from "./diff.ts"
import type { Block } from "./trace.ts"

export interface ChangedBlock {
  /** 1-based block number. */
  number: number
  kind: Block["kind"]
  /** Plain description, e.g. `tool "write_file"`, `system part 1`, `message #3 (assistant)`. */
  label: string
}

/** Names the block at `index`, in `prev`'s numbering: what it was, and what is there now when that differs. */
export function describeBlock(prev: Block[], next: Block[], index: number): ChangedBlock {
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

/**
 * What to do about a change. The advice is the same in a test and for a trace; only how an
 * intentional change is declared differs (`allowBreak` in a test, a `prefix_break` hint in a trace).
 */
export function fixFor(cause: Cause, where: "test" | "trace"): string | undefined {
  return (where === "trace" ? TRACE_FIXES[cause] : undefined) ?? FIXES[cause]
}

const FIXES: Partial<Record<Cause, string>> = {
  model_changed: "caches are per model; a model switch always starts cold, so switch only at a deliberate breakpoint.",
  params_changed: "keep cache-relevant parameters fixed for the session, or declare the change ({ allowBreak: \"settings_change\" }) when the user asked for it; if your provider does not cache on the parameter, list it in ignoreParams and tell us how you verified it.",
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
  message_removed: "do not drop sent messages; if this was a deliberate compaction, revert or refused exchange, declare it with allowBreak (\"compaction\", \"revert\", \"refusal\").",
  oldest_messages_removed:
    "a window that slides on every call re-reads the whole history each time: drop history in chunks at a saved boundary (cut rarely, and replay from the same cut until the next one), or keep history append-only.",
  history_truncated: "if this was a deliberate compaction or revert, declare it with allowBreak (\"compaction\", \"revert\").",
  history_rewound: "if this was a deliberate revert, declare it with { allowBreak: \"revert\" }.",
  compaction: "a compaction always breaks the prefix; mark it with { allowBreak: { reason: \"compaction\" } }.",
}

// The entries above that name a test option, worded for a recorded trace.
const TRACE_FIXES: Partial<Record<Cause, string>> = {
  params_changed: "keep cache-relevant parameters fixed for the session, or declare the change (a prefix_break hint with reason \"settings_change\") when the user asked for it.",
  message_removed: "do not drop sent messages; if this was a deliberate compaction, revert or refused exchange, declare it with a prefix_break hint (\"compaction\", \"revert\", \"refusal\").",
  history_truncated: "if this was a deliberate compaction or revert, declare it with a prefix_break hint (\"compaction\", \"revert\").",
  history_rewound: "if this was a deliberate revert, declare it with a prefix_break hint (reason \"revert\").",
  compaction: "a compaction always breaks the prefix; declare it with a prefix_break hint (reason \"compaction\") so it is counted apart from misses.",
}
