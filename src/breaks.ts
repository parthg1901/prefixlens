// Intentional prefix breaks: a harness says it broke its own prefix on purpose
// (a compaction, a revert, a refused exchange left out, a model or setting
// changed at the user's request). SPEC.md section 6.1.
//
// A declaration excuses the miss of the call that carries it, and only when
// the first change lies after the part the declaration says must survive. The
// report and `assertPrefixStable` share this file so they always agree.

import type { PrefixChange } from "./diff.ts"
import type { Block, Hint } from "./trace.ts"

/** Where a break may start, as the last part that must stay unchanged. */
export type Position =
  /** Nothing has to stay: the whole request may change, model included. */
  | "start"
  /** The tool list must stay. */
  | "tools"
  /** Tools and system prompt (instructions) must stay. */
  | "system"
  /** Tools, system prompt and messages 1..n must stay. */
  | { message: number }
  /** The first n blocks must stay. */
  | number

/**
 * The reasons SPEC.md names, and how far each reaches by default when a
 * declaration does not say `after`. Other reasons are allowed and reach
 * anywhere ("start").
 */
export const BREAK_REASONS = {
  /** History summarized or replaced; the harness may rebuild its instructions and tools too. */
  compaction: "start",
  /** The user rewound the conversation to an earlier point: messages are gone, tools and instructions stay. */
  revert: "system",
  /** A refused exchange was left out of history: messages are gone, tools and instructions stay. */
  refusal: "system",
  /** The model changed: caches are per model. */
  model_switch: "start",
  /** A request setting (reasoning effort, thinking, verbosity) changed at the user's request. */
  settings_change: "start",
} as const satisfies Record<string, Position>

export type BreakReason = keyof typeof BREAK_REASONS

export interface DeclaredBreak {
  reason: string
  after: Position
  detail?: string
  /** The hint kind it came from: `prefix_break`, or the older `compaction` and `model_switch` kinds. */
  kind: string
}

/** The breaks a record's hints declare. Older `compaction` and `model_switch` hints declare one too. */
export function declaredBreaks(hints: Hint[] | undefined): DeclaredBreak[] {
  return (hints ?? []).flatMap((hint): DeclaredBreak[] => {
    const detail = typeof hint.detail === "string" ? { detail: hint.detail } : {}
    if (hint.kind === "prefix_break" && typeof hint.reason === "string")
      return [{ reason: hint.reason, after: hint.after ?? defaultAfter(hint.reason), ...detail, kind: hint.kind }]
    if (hint.kind === "compaction" || hint.kind === "model_switch") return [{ reason: hint.kind, after: "start", ...detail, kind: hint.kind }]
    return []
  })
}

export function defaultAfter(reason: string): Position {
  return (BREAK_REASONS as Record<string, Position>)[reason] ?? "start"
}

/** Number of leading blocks of `blocks` that `position` says must stay unchanged. */
export function keptBlocks(position: Position, blocks: Block[]): number {
  if (position === "start") return 0
  if (typeof position === "number") return position
  const lastOf = (kinds: Block["kind"][]) => blocks.findLastIndex((block) => kinds.includes(block.kind)) + 1
  if (position === "tools") return lastOf(["tool"])
  if (position === "system") return lastOf(["tool", "system"])
  const firstMessage = blocks.findIndex((block) => block.kind === "message")
  return (firstMessage === -1 ? blocks.length : firstMessage) + position.message
}

/**
 * Index of the first block of `prev` the change invalidates: 0 for a model
 * change, the start of the part a parameter change reaches, otherwise the
 * first block that differs.
 */
export function changeStart(change: PrefixChange, prev: Block[]): number {
  if (change.region === "model") return 0
  if (change.region === "params") {
    const from = change.detail.from
    const first = (kind: Block["kind"]) => {
      const index = prev.findIndex((block) => block.kind === kind)
      return index === -1 ? prev.length : index
    }
    if (from === "messages") return first("message")
    if (from === "system") return Math.min(first("system"), first("message"))
    return 0
  }
  return change.block_index ?? 0
}

/** The declarations that allow `change`: those whose kept part ends at or before where the change starts. */
export function coveringBreaks(declared: DeclaredBreak[], change: PrefixChange, prev: Block[]): DeclaredBreak[] {
  const start = changeStart(change, prev)
  return declared.filter((entry) => start >= keptBlocks(entry.after, prev))
}

/** "the system prompt", "message 2", "block 5": the part a position keeps, for messages. */
export function describePosition(position: Position): string {
  if (position === "start") return "nothing"
  if (position === "tools") return "the tools"
  if (position === "system") return "the tools and system prompt"
  if (typeof position === "number") return `the first ${position} ${position === 1 ? "block" : "blocks"}`
  return `the tools, system prompt and message${position.message === 1 ? "" : "s"} 1${position.message === 1 ? "" : `-${position.message}`}`
}

/** True for a valid `after` value: "start", "tools", "system", a block count, or `{ message: n }`. */
export function isPosition(value: unknown): value is Position {
  if (value === "start" || value === "tools" || value === "system") return true
  if (typeof value === "number") return Number.isInteger(value) && value >= 0
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && Number.isInteger((value as { message?: unknown }).message) && (value as { message: number }).message >= 0
}
