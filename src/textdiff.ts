// A small line diff for showing what changed inside one block.

import { isRecord } from "./canonical.ts"
import { printable } from "./printable.ts"

/**
 * Renders a JSON value as readable lines: `path: value`, with multi-line
 * strings broken into indented lines so a diff can point at the changed line.
 */
export function flatten(value: unknown): string[] {
  const out: string[] = []
  walk(value, "", out)
  return out
}

function walk(value: unknown, path: string, out: string[]) {
  const label = path === "" ? "" : `${path}: `
  if (Array.isArray(value)) {
    if (value.length === 0) out.push(`${label}[]`)
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out))
    return
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) out.push(`${label}{}`)
    for (const key of keys) walk(value[key], path === "" ? key : `${path}.${key}`, out)
    return
  }
  if (typeof value === "string" && value.includes("\n")) {
    out.push(`${label}|`)
    for (const line of value.split("\n")) out.push(`  ${line}`)
    return
  }
  out.push(`${label}${typeof value === "string" ? value : JSON.stringify(value)}`)
}

export type DiffOp = { op: "same" | "del" | "add"; line: string }

/** Line diff via longest common subsequence on the region between common prefix and suffix. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map((line): DiffOp => ({ op: "same", line }))
  const tail = a.slice(endA).map((line): DiffOp => ({ op: "same", line }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  // Past this size an exact LCS is not worth the memory; show the region as replaced.
  if (midA.length * midB.length > 4_000_000)
    return [...head, ...midA.map((line): DiffOp => ({ op: "del", line })), ...midB.map((line): DiffOp => ({ op: "add", line })), ...tail]
  return [...head, ...lcs(midA, midB), ...tail]
}

function lcs(a: string[], b: string[]): DiffOp[] {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", line: a[i]! })
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) out.push({ op: "del", line: a[i++]! })
    else out.push({ op: "add", line: b[j++]! })
  }
  while (i < a.length) out.push({ op: "del", line: a[i++]! })
  while (j < b.length) out.push({ op: "add", line: b[j++]! })
  return out
}

export interface DiffOptions {
  context?: number
  maxLines?: number
  maxLineWidth?: number
}

/**
 * A unified-style excerpt: changed lines with a little context, capped in length. Its lines are for
 * people to read in a terminal, a CI log or a report, so control characters in the content are
 * written visibly (`printable`).
 */
export function renderDiff(before: unknown, after: unknown, options: DiffOptions = {}): string {
  const context = options.context ?? 2
  const maxLines = options.maxLines ?? 24
  const width = options.maxLineWidth ?? 160
  const ops = diffLines(flatten(before), flatten(after))
  const changed = ops.flatMap((op, index) => (op.op === "same" ? [] : [index]))
  if (changed.length === 0) return ""
  const keep = new Set<number>()
  for (const index of changed)
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep.add(k)
  const lines: string[] = []
  let last = -1
  for (let index = 0; index < ops.length; index++) {
    if (!keep.has(index)) continue
    if (last !== -1 && index > last + 1) lines.push("  ...")
    last = index
    lines.push(...renderOp(ops, index, width).map(printable))
  }
  if (lines.length <= maxLines) return lines.join("\n")
  const hidden = lines.slice(maxLines).filter((line) => line.startsWith("-") || line.startsWith("+")).length
  return [...lines.slice(0, maxLines), `  ... (${hidden} more changed lines)`].join("\n")
}

function renderOp(ops: DiffOp[], index: number, width: number): string[] {
  const op = ops[index]!
  const prefix = op.op === "same" ? " " : op.op === "del" ? "-" : "+"
  // A deleted line followed by an added one is usually one edited line; show
  // both around the changed span so long lines stay readable.
  const next = ops[index + 1]
  const previous = ops[index - 1]
  if (op.op === "del" && next?.op === "add") return [`${prefix} ${excerpt(op.line, next.line, width)[0]}`]
  if (op.op === "add" && previous?.op === "del") return [`${prefix} ${excerpt(previous.line, op.line, width)[1]}`]
  return [`${prefix} ${clip(op.line, width)}`]
}

/** Trims two edited versions of a line to a window around the part that differs. */
export function excerpt(a: string, b: string, width: number): [string, string] {
  if (a.length <= width && b.length <= width) return [a, b]
  const span = changedSpan(a, b)
  const pad = Math.max(20, Math.floor((width - Math.max(span.a.length, span.b.length)) / 2))
  const cut = (text: string, from: number, to: number) => {
    const left = Math.max(0, from - pad)
    const right = Math.min(text.length, to + pad)
    return `${left > 0 ? "…" : ""}${clip(text.slice(left, right), width)}${right < text.length ? "…" : ""}`
  }
  return [cut(a, span.start, span.endA), cut(b, span.start, span.endB)]
}

/** The differing middle of two strings after removing their common prefix and suffix. */
export function changedSpan(a: string, b: string) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return { start, endA, endB, a: a.slice(start, endA), b: b.slice(start, endB) }
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}
