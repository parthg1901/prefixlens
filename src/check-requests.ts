// `prefixlens check --requests <file>`: `assertSessionStable` for request bodies that a test in any
// language captured, with no script. The bodies are read from a JSON array or from JSON Lines, and
// the result is an exit code in the meaning `prefixlens check` gives it: 0 pass, 1 a call breaks the
// prefix, 2 the check could not be made.

import { PrefixBreakError } from "./assert.ts"
import { isRecord, type Provider } from "./canonical.ts"
import { printable } from "./printable.ts"
import { assertSessionStable, type CallExplanation, type StabilityOptions } from "./session.ts"

export const REQUEST_PROVIDERS: readonly Provider[] = ["anthropic", "openai", "gemini"]

export interface RequestsCheck {
  code: 0 | 1 | 2
  /** The verdict, for stdout. */
  stdout?: string
  /** Why the check could not be made, for stderr. */
  error?: string
}

/**
 * The request bodies in `text`, in order: a JSON array of objects, or one object per line (JSON
 * Lines; blank lines are skipped). Returns a message saying what is wrong when it is neither.
 */
export function parseRequestBodies(text: string, name: string): Record<string, unknown>[] | string {
  const source = text.replace(/^﻿/, "")
  if (source.trim() === "") return `${name} is empty: no request bodies`
  if (source.trimStart().startsWith("[")) {
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch (error) {
      return `${name} is not valid JSON (${error instanceof Error ? error.message : String(error)}); write a JSON array of request bodies, or one body per line (JSON Lines)`
    }
    if (!Array.isArray(value)) return `${name} is not a JSON array of request bodies`
    if (value.length === 0) return `${name} is an empty array: no request bodies`
    const bad = value.findIndex((entry) => !isRecord(entry))
    if (bad !== -1) return `${name}: entry ${bad + 1} of the array is ${kind(value[bad])}, not a request body object`
    return value as Record<string, unknown>[]
  }
  const bodies: Record<string, unknown>[] = []
  const lines = source.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return `${name}: line ${index + 1} is not valid JSON${wholeValue(source)}; write a JSON array of request bodies, or one body per line (JSON Lines)`
    }
    if (!isRecord(value)) return `${name}: line ${index + 1} is ${kind(value)}, not a request body object`
    bodies.push(value)
  }
  return bodies
}

// A pretty-printed object or a bare value fails line by line; say what the file holds instead.
function wholeValue(source: string): string {
  try {
    return ` (the file holds ${kind(JSON.parse(source))}, not a list of request bodies)`
  } catch {
    return ""
  }
}

function kind(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (isRecord(value)) return "one JSON object"
  return `a ${typeof value}`
}

/** `7=compaction,12=revert` as `allowBreakAt`. Returns a message when an entry is not `<call>=<reason>`. */
export function parseAllowBreakAt(value: string): Record<number, string> | string {
  const allowed: Record<number, string> = {}
  for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = /^(\d+)\s*=\s*(\S.*)$/.exec(entry)
    if (!match) return `--allow-break-at ${entry}: write <call>=<reason>, e.g. 7=compaction (calls are numbered from 1, in the order the bodies were sent)`
    const call = Number(match[1])
    if (call < 1) return `--allow-break-at ${entry}: calls are numbered from 1`
    if (allowed[call] !== undefined) return `--allow-break-at names call ${call} twice`
    allowed[call] = match[2]!.trim()
  }
  if (Object.keys(allowed).length === 0) return "--allow-break-at needs <call>=<reason>, e.g. 7=compaction"
  return allowed
}

/** Checks the bodies exactly as `assertSessionStable` does, and words the result for the command line. */
export function checkRequests(bodies: Record<string, unknown>[], options: StabilityOptions, title: string): RequestsCheck {
  const heading = `prefixlens check: ${printable(title)}\n`
  if (bodies.every((body) => body.v === 1 && isRecord(body.usage)))
    return { code: 2, error: `${title} is a prefixlens trace, not a list of request bodies; check it with prefixlens check <trace>, without --requests` }
  for (const key of Object.keys(options.allowBreakAt ?? {}))
    if (Number(key) > bodies.length) return { code: 2, error: `--allow-break-at names call ${key}, but ${title} holds ${bodies.length === 1 ? "1 request body" : `${bodies.length} request bodies`} (numbered from 1)` }
  let explanations: CallExplanation[]
  try {
    explanations = assertSessionStable(bodies, options)
  } catch (error) {
    if (error instanceof PrefixBreakError) return { code: 1, stdout: `${heading}FAIL: ${forCommandLine(error.message)}\n` }
    // Nothing to compare, calls that continue a conversation the provider keeps, or an option that names no call it can apply to.
    return { code: 2, error: forCommandLine(error instanceof Error ? error.message : String(error)) }
  }
  // A lane opens with a call that is compared with nothing, or with one that carries another lane's conversation on.
  const lanes = bodies.length - explanations.length + explanations.filter((explanation) => explanation.follows !== undefined).length
  const allowed = explanations.filter((explanation) => !explanation.stable && explanation.allowed !== undefined)
  const breaks =
    allowed.length === 0
      ? ""
      : `; ${allowed.length === 1 ? "break allowed at call" : "breaks allowed at calls"} ${allowed.map((explanation) => `${explanation.call} (${printable(explanation.allowed!)})`).join(", ")}`
  const compared = explanations.length === 1 ? "1 call compared" : `${explanations.length} calls compared`
  // A call that is not compared with an earlier one is the first of a lane. After call 1 that is a request
  // judged to be another conversation: named, so that a reader can see when that judgement is wrong.
  const checked = new Set(explanations.map((explanation) => explanation.call))
  const starts = bodies.map((_, index) => index + 1).filter((call) => call > 1 && !checked.has(call))
  const alone =
    starts.length === 0
      ? ""
      : starts.length === 1
        ? `: call ${starts[0]} starts a conversation of its own and is compared with nothing`
        : `: calls ${starts.slice(0, -1).join(", ")} and ${starts.at(-1)} each start a conversation of their own and are compared with nothing`
  return {
    code: 0,
    stdout: `${heading}ok: ${compared}, each keeps the prefix of the call before it in its lane (${bodies.length} request bodies, ${lanes === 1 ? "1 lane" : `${lanes} lanes`}${alone}${breaks})\n`,
  }
}

// The messages are written for a JavaScript test; say the same in the command's own terms.
function forCommandLine(message: string): string {
  return message
    .replace(/^(prefixlens\/test|assertSessionStable): /, "")
    .replace(/pass \{ allowBreakAt: \{ (\d+): \{ reason: "\.\.\." \} \} \}/g, "pass --allow-break-at $1=<reason>")
    .replace(/^allowBreakAt names/, "--allow-break-at names")
}
