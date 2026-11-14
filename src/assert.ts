// prefixlens/test: prefix-stability assertions for a harness's own tests.
//
// Pure functions, no network. Give them two consecutive requests a harness
// built (request bodies as sent, canonical requests, or trace records) and they
// say whether the second one keeps the first one's cached prefix, and if not,
// which block changed and how.

import { changeStart, declaredBreaks, defaultAfter, describePosition, isPosition, keptBlocks, POSITIONS, type DeclaredBreak, type Position } from "./breaks.ts"
import { canonicalizeRequest, isItemReference, type CanonicalRequest, type Provider } from "./canonical.ts"
import { describeBlock, fixFor, type ChangedBlock } from "./advice.ts"
import { comparePrefix, type PrefixChange } from "./diff.ts"
import { printable } from "./printable.ts"
import { apiFromBody, PROVIDER_OF } from "./record/exchange.ts"
import { prefixBlocks, type Block, type Hint, type TraceRecord } from "./trace.ts"

/**
 * A request to compare: a request body as sent to Anthropic Messages, OpenAI
 * Chat Completions or OpenAI Responses (or Gemini with `provider: "gemini"`);
 * a canonical request (`{ model, params, blocks }`); a trace record; or a
 * bare list of blocks.
 */
export type RequestLike = Record<string, unknown> | TraceRecord | CanonicalRequest | Block[]

export type { ChangedBlock, Position }

export interface PrefixOptions {
  /** Request format, when it cannot be told from the body (always needed for Gemini). */
  provider?: Provider
  /**
   * An intentional break, with the same meaning as a `prefix_break` hint in a
   * trace (SPEC 6.1): the prefix may change after `after` because of
   * `reason`. Without `after`, the reason decides how far the break may
   * reach: "revert" and "refusal" must keep the tools and system prompt;
   * "compaction", "model_switch", "settings_change" and any other reason may
   * change anything. A plain string is a reason with its default reach.
   */
  allowBreak?: string | { after?: Position; reason?: string }
  /** Request parameters to leave out of the comparison, e.g. `["truncation"]` once you have shown your provider does not cache on it (built-in rules: SPEC 8.1). */
  ignoreParams?: string[]
  /**
   * Trace hints about what happened between the requests, used to name the
   * change. A `prefix_break` hint, or an older `compaction` or `model_switch`
   * hint, also allows the break exactly as the report would: so do those on
   * `next` when it is a trace record.
   */
  hints?: Hint[]
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
  /**
   * How many of the unchanged blocks are OpenAI Responses `item_reference` items. They are compared
   * by the id they name: the item itself was not in the request, so its content and size are unknown.
   * Absent when there are none.
   */
  references?: number
  /** What to do about it. */
  fix?: string
  /** Plain-English explanation; the assertion's failure message. */
  message: string
}

export class PrefixBreakError extends Error {
  override name = "PrefixBreakError"
  readonly explanation: PrefixExplanation

  constructor(explanation: PrefixExplanation) {
    super(explanation.message)
    this.explanation = explanation
  }
}

/**
 * Explains how `next` departs from `prev` as a prompt-cache prefix. Never throws
 * for a change; `ok` says whether it is allowed.
 */
export function explainPrefixDiff(prev: RequestLike, next: RequestLike, options: PrefixOptions = {}): PrefixExplanation {
  return explainPair(prev, next, options, PAIR_WORDING)
}

/** How a failure is worded: what it opens with, and the option that would allow the change. */
export interface Wording {
  heading: string
  allow: string
}

const PAIR_WORDING: Wording = { heading: "prefix not stable", allow: 'pass { allowBreak: { reason: "..." } }' }

/** `explainPrefixDiff` with the failure worded by the caller: the test session names the two calls and its per-call option. */
export function explainPair(prev: RequestLike, next: RequestLike, options: PrefixOptions, wording: Wording): PrefixExplanation {
  const before = comparable(prev, options)
  const after = comparable(next, options)
  const given = typeof options.allowBreak === "string" ? { reason: options.allowBreak } : options.allowBreak
  if (given?.after !== undefined && !isPosition(given.after)) throw new TypeError(`prefixlens/test: allowBreak.after ${JSON.stringify(given.after)} is not a position; ${POSITIONS}`)
  const recordHints = isTraceRecord(next) ? (next.hints ?? []) : []
  const allowances: DeclaredBreak[] = [
    ...(given ? [{ reason: given.reason ?? "an intentional break", after: given.after ?? defaultAfter(given.reason ?? ""), kind: "allowBreak" }] : []),
    ...declaredBreaks([...(options.hints ?? []), ...recordHints]),
  ]
  // A break the caller says is a compaction is named as one, whatever it looks like.
  const hints = [...(options.hints ?? []), ...recordHints, ...(given?.reason === "compaction" ? [{ kind: "compaction" as const }] : [])]
  const change = comparePrefix(before, { ...after, ...(hints.length > 0 ? { hints } : {}) })
  if (!change) {
    const appended = after.blocks.length - before.blocks.length
    const references = before.blocks.filter(isItemReference).length
    const byId =
      references === 0
        ? ""
        : `; ${references} of the unchanged blocks ${references === 1 ? "is an item_reference, compared by id only: the item it names was not in the request, so its content and size are unknown" : "are item_reference items, compared by id only: the items they name were not in the request, so their content and size are unknown"}`
    return {
      stable: true,
      ok: true,
      appended,
      unchanged: before.blocks.length,
      change: null,
      ...(references > 0 ? { references } : {}),
      message: `prefix stable: all ${before.blocks.length} blocks of the previous request are unchanged${appended > 0 ? `, and ${appended} ${plural(appended, "block")} ${appended === 1 ? "was" : "were"} appended` : ""}${byId}`,
    }
  }
  const changedAt = changeStart(change, before.blocks)
  const references = before.blocks.slice(0, changedAt).filter(isItemReference).length
  const covering = allowances.filter((entry) => changedAt >= keptBlocks(entry.after, before.blocks))
  const ok = covering.length > 0
  const block = change.block_index === undefined ? undefined : describeBlock(before.blocks, after.blocks, change.block_index)
  const fix = fixFor(change.cause, "test")
  // The allowance that reaches furthest, to say how far a break was allowed when none reaches far enough.
  const widest = allowances.toSorted((a, b) => keptBlocks(a.after, before.blocks) - keptBlocks(b.after, before.blocks))[0]
  const reason = ok ? [...new Set(covering.map((entry) => entry.reason))].join(", ") : (widest?.reason ?? "an intentional break")
  const keep = widest ? keptBlocks(widest.after, before.blocks) : undefined
  return {
    stable: false,
    ok,
    appended: 0,
    unchanged: changedAt,
    change,
    ...(block ? { block } : {}),
    ...(ok ? { allowed: reason } : {}),
    ...(references > 0 ? { references } : {}),
    ...(fix ? { fix } : {}),
    // The message names tools, models and parameters and quotes the diff, all taken from the requests;
    // it ends up in a test runner's output and in CI logs.
    message: printable(
      ok
        ? `prefix changed at block ${changedAt + 1}, allowed (${reason}): ${change.summary}`
        : failureMessage(wording, change, before.blocks, changedAt, block, fix, widest && keep !== undefined ? { reason, keep, after: widest.after } : undefined),
    ),
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

function failureMessage(wording: Wording, change: PrefixChange, blocks: Block[], changedAt: number, block: ChangedBlock | undefined, fix: string | undefined, allowed: { reason: string; keep: number; after: Position } | undefined): string {
  const evidence = change.detail.evidence as Record<string, string> | undefined
  const where =
    change.region === "model"
      ? "the model changed, so nothing in the cache applies"
      : change.region === "params"
        ? `a cache-relevant request parameter changed (${Object.entries(evidence ?? {}).map(([key, value]) => `${key}: ${value}`).join(", ")}); it invalidates ${changedAt >= blocks.length ? "nothing already sent" : changedAt === 0 ? `the whole request (${range(1, blocks.length)})` : range(changedAt + 1, blocks.length)}`
        : `first changed block: ${block!.number} of ${blocks.length} (${block!.label}); ${changedAt === 0 ? "nothing before it matches, so the whole request is re-read" : `${range(1, changedAt)} still ${changedAt === 1 ? "matches" : "match"}, everything from block ${changedAt + 1} on is re-read`}`
  const lines = [`${wording.heading}: ${change.summary}`, "", `  ${where}`]
  if (allowed) lines.push(`  a break was allowed (${allowed.reason}) only after block ${allowed.keep} (${describePosition(allowed.after)} must stay), and this one is earlier`)
  if (change.diff) lines.push("", ...clip(change.diff.split("\n"), 16).map((line) => `    ${line}`))
  if (fix) lines.push("", `  fix: ${fix}`)
  if (!allowed) lines.push(`  if this change is intentional, ${wording.allow}`)
  return lines.join("\n")
}

function comparable(value: RequestLike, options: PrefixOptions) {
  const ignore = (params: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => !options.ignoreParams?.includes(key)))
  // Which provider's parameter rules apply: the option, else the trace record's provider, else the body's API.
  const known = options.provider ? { provider: options.provider } : {}
  // Deferred tools are recorded but are not part of the prefix: block numbers and counts leave them out.
  if (Array.isArray(value)) return { ...known, model: "", params: {}, blocks: prefixBlocks(value) }
  const body = value as Record<string, unknown>
  if (Array.isArray(body.blocks)) return { ...known, model: String(body.model ?? ""), params: ignore(body.params as Record<string, unknown>), blocks: prefixBlocks(body.blocks as Block[]) }
  if (isTraceRecord(value)) {
    if (!value.request) throw new TypeError("prefixlens/test: a usage-only trace record has no request to compare")
    return { provider: options.provider ?? value.provider, model: value.model ?? "", params: ignore(value.params), blocks: prefixBlocks(value.request.blocks) }
  }
  const provider = options.provider ?? PROVIDER_OF[apiFromBody(body)]
  const canonical = canonicalizeRequest(provider, body)
  return { provider, model: canonical.model, params: ignore(canonical.params), blocks: prefixBlocks(canonical.blocks) }
}

function isTraceRecord(value: RequestLike): value is TraceRecord {
  const record = value as Partial<TraceRecord>
  return !Array.isArray(value) && record.v === 1 && typeof record.fidelity === "string"
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

