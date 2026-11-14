// The CI gate behind `prefixlens check`: sorts every call of an analysis into
// one class and says which classes fail. It adds no analysis of its own: the
// class of a call follows from what the report already found about it.

import { fixFor } from "./advice.ts"
import type { Analysis, TurnResult } from "./analyze.ts"
import type { Cause } from "./diff.ts"

/**
 * What a call is, for a pass-or-fail decision:
 * - `avoidable`: it lost cached tokens for a reason the harness controls (a changed tool list, system prompt, history, model or parameter) that no declaration allows;
 * - `undeclared-change`: it lost none, but its request does not extend the previous one in its lane where the next call could have read the cache, and no declaration allows that;
 * - `unexplained`: it lost cached tokens and the trace cannot say why (a usage-only record);
 * - `intentional`: it lost cached tokens to a break the harness declared, or to a cause named in `allow`;
 * - `expiry`: the prefix was intact and the cache lifetime had passed;
 * - `provider-side`: the prefix was intact and in time: the provider evicted the entry or routed the request elsewhere;
 * - `cold-start`, `warm-start`: the first call of its lane, which read nothing, or read a cache left from outside the lane;
 * - `ok`: every other call.
 */
export type MissClass = "avoidable" | "undeclared-change" | "unexplained" | "intentional" | "expiry" | "provider-side" | "cold-start" | "warm-start" | "ok"

/** Every class, in the order counts are listed. */
export const MISS_CLASSES: readonly MissClass[] = ["avoidable", "undeclared-change", "unexplained", "intentional", "expiry", "provider-side", "cold-start", "warm-start", "ok"]

// The classes that always fail; `failOn` adds more.
const DEFAULT_FAIL_ON: readonly MissClass[] = ["avoidable", "undeclared-change"]

export interface CallVerdict {
  /** 1-based position of the call in the trace, as in the report. */
  turn: number
  lane: string
  session?: string
  class: MissClass
  /** True when the call's class is one that fails the check. */
  fails: boolean
  /** What happened, in a sentence. */
  summary: string
  /** The cause the report names, when the call has one. */
  cause?: Cause
  /** The first block that differs, e.g. `4 (tool "web_search", added)`. */
  block?: string
  /** A diff excerpt of that block. */
  diff?: string
  /** What to do about it. */
  fix?: string
  lost_tokens: number
  expected_cached_tokens: number
  /** What the lost tokens cost above the cache-read price, at list prices; null when the model has no price. */
  miss_cost: number | null
  /** The call it was compared with: the one before it in its lane. */
  baseline_turn?: number
}

export interface Check {
  /** True when no call is in a failing class. */
  ok: boolean
  /** The classes that fail. */
  fail_on: MissClass[]
  counts: Record<MissClass, number>
  /** One verdict per call, in trace order. */
  calls: CallVerdict[]
}

export interface CheckOptions {
  /** Classes that fail besides `avoidable` and `undeclared-change`, e.g. `["expiry", "provider-side"]`. */
  failOn?: readonly MissClass[]
  /**
   * Causes that are intentional in this trace, e.g. `["compaction"]`: a call they explain is `intentional`.
   * For a trace whose writer cannot declare breaks (the proxy sees requests, not intentions).
   */
  allow?: readonly Cause[]
}

/** True for a cause a harness can be asked to fix: every cause but a cold start, an expiry, a provider-side miss and an unknown one. */
export function isHarnessCause(cause: Cause): boolean {
  return !["cold_start", "cache_expired", "provider_side", "unknown"].includes(cause)
}

/**
 * Sorts each call of an analysis into a class (see `MissClass`) and says whether the trace passes.
 * `prefixlens check` prints this.
 *
 *   const check = classifyMisses(analyze(parseTrace(text).records, { pricing: await loadPricing() }))
 *   if (!check.ok) console.log(check.calls.filter((call) => call.fails))
 */
export function classifyMisses(analysis: Analysis, options: CheckOptions = {}): Check {
  const failOn = MISS_CLASSES.filter((name) => name !== "ok" && (DEFAULT_FAIL_ON.includes(name) || options.failOn?.includes(name)))
  const calls = analysis.turns.map((turn) => verdict(turn, failOn, options.allow ?? []))
  const counts = Object.fromEntries(MISS_CLASSES.map((name) => [name, calls.filter((call) => call.class === name).length])) as Record<MissClass, number>
  return { ok: calls.every((call) => !call.fails), fail_on: failOn, counts, calls }
}

function verdict(turn: TurnResult, failOn: MissClass[], allow: readonly Cause[]): CallVerdict {
  const lost = turn.status === "miss" || turn.status === "partial"
  // A change beside the cause, or on a call that lost nothing, that the harness has to answer for.
  const beside = turn.prefix_change && !turn.prefix_change_excused ? turn.prefix_change : undefined
  const found = classOf(turn, lost, beside !== undefined)
  // The change a failing class is about: the cause of the loss, or the change found beside it.
  const change = found === "avoidable" ? turn.cause : found === "undeclared-change" ? beside : undefined
  const allowed = change !== undefined && allow.includes(change.cause)
  const name = allowed ? "intentional" : found
  const shown = change ?? (lost ? turn.cause : undefined)
  const fix = name === "intentional" ? undefined : change ? fixFor(change.cause, "trace") : FIXES[name]
  return {
    turn: turn.turn,
    lane: turn.lane,
    ...(turn.session ? { session: turn.session } : {}),
    class: name,
    fails: failOn.includes(name),
    summary: summaryOf(turn, name, shown?.summary, allowed ? change.cause : undefined),
    ...(shown ? { cause: shown.cause } : {}),
    ...(shown?.block_index !== undefined && shown.block_label ? { block: `${shown.block_index + 1} (${shown.block_label})` } : {}),
    ...(shown?.diff ? { diff: shown.diff } : {}),
    ...(fix ? { fix } : {}),
    lost_tokens: turn.lost_tokens,
    expected_cached_tokens: turn.expected_cached_tokens,
    miss_cost: turn.miss_cost,
    ...(turn.baseline_turn === undefined ? {} : { baseline_turn: turn.baseline_turn }),
  }
}

function classOf(turn: TurnResult, lost: boolean, changed: boolean): MissClass {
  if (turn.baseline_turn === undefined) return turn.warm_start ? "warm-start" : "cold-start"
  if (!lost) return changed ? "undeclared-change" : "ok"
  if (turn.declared_break?.intentional) return "intentional"
  const cause = turn.cause?.cause ?? "unknown"
  if (cause === "unknown") return "unexplained"
  // The cache was gone or never read whatever the harness did; a change found beside that is still the harness's.
  if (cause === "cache_expired" || cause === "provider_side") return changed ? "undeclared-change" : cause === "cache_expired" ? "expiry" : "provider-side"
  return "avoidable"
}

function summaryOf(turn: TurnResult, name: MissClass, change: string | undefined, allowed: Cause | undefined): string {
  if (name === "cold-start") return "first call in its lane: nothing cached yet"
  if (name === "warm-start") return "first call in its lane, and it read a cache left from outside the lane"
  if (name === "ok") return turn.status === "uncached" ? "nothing cacheable from the call before, and the request extends it" : "read the cache the call before left"
  if (allowed) return `${change} (allowed: ${allowed})`
  if (name === "intentional") return `${change ?? "cause unknown"} (declared: ${turn.declared_break!.reasons.join(", ")})`
  if (name === "undeclared-change")
    return turn.cause?.cause === "cache_expired"
      ? `${change}; the cache had expired by then, so the change cost nothing more on this call`
      : `${change}; no cached tokens were lost on this call, but the request does not extend the one before it`
  return change ?? "cause unknown"
}

// What to do about a class that has no changed block behind it.
const FIXES: Partial<Record<MissClass, string>> = {
  unexplained: "this call is recorded with usage only: record full requests (the proxy, wrap or lens.fetch) to get a cause.",
  expiry: "send the next call within the cache lifetime, or ask for a longer one where the provider offers it (Anthropic: a cache_control ttl of \"1h\").",
  "provider-side": "nothing in the request changed: the provider evicted the entry or routed the request elsewhere. Nothing to fix in the harness.",
}
