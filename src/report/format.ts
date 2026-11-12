// Shared formatting for the reports.

import { money } from "../analyze.ts"
import type { Analysis, Status, TurnResult } from "../analyze.ts"

export { money }

export function tokens(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US")
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`
}

export function exact(value: number): string {
  return value.toLocaleString("en-US")
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(value >= 0.995 || value === 0 ? 0 : 1)}%`
}

/** HH:MM:SS (UTC), or MM-DD HH:MM when the trace spans more than one day. */
export function clock(ts: string, withDate = false): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ""
  const iso = date.toISOString()
  return withDate ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 19)
}

export function spansDays(turns: { ts: string }[]): boolean {
  const days = new Set(turns.map((turn) => turn.ts.slice(0, 10)))
  return days.size > 1
}

export const STATUS_LABEL: Record<Status, string> = {
  cold: "cold",
  hit: "hit",
  partial: "partial miss",
  miss: "miss",
  uncached: "no cache",
}

/** A call that lost cached tokens and that the harness did not declare as an intentional break: an avoidable miss. */
export function isMiss(turn: TurnResult): boolean {
  return (turn.status === "miss" || turn.status === "partial") && !turn.declared_break?.intentional
}

/** A call that lost cached tokens because of a break the harness declared (SPEC 6.1). */
export function isIntentional(turn: TurnResult): boolean {
  return (turn.status === "miss" || turn.status === "partial") && Boolean(turn.declared_break?.intentional)
}

/** "intentional break (compaction)" */
export function intentionalLabel(turn: TurnResult): string {
  return `intentional break (${turn.declared_break!.reasons.join(", ")})`
}

/** "turn 41: miss, tool list changed (+2 tools), ~$0.38", or "turn 9: intentional break (revert), cost ~$0.05: history rewound …" */
export function missLine(turn: TurnResult): string {
  const cost = turn.miss_cost === null ? "" : `, ~${money(turn.miss_cost)}`
  if (isIntentional(turn)) return `turn ${turn.turn}: ${intentionalLabel(turn)}${cost}; ${turn.cause?.summary ?? "cause unknown"}`
  return `turn ${turn.turn}: ${STATUS_LABEL[turn.status]}, ${turn.cause?.summary ?? "cause unknown"}${cost}`
}

/** Facts under a miss line: tokens lost, baseline, lane, confidence, and for a declared break whether it was checked. */
export function missFacts(turn: TurnResult, multiLane: boolean, lane: (name: string) => string = (name) => name): string[] {
  const declared = turn.declared_break
  return [
    `lost ${exact(turn.lost_tokens)} of ${exact(turn.expected_cached_tokens)} cached tokens`,
    turn.baseline_turn ? `vs turn ${turn.baseline_turn}` : "",
    multiLane ? `lane ${lane(turn.lane)}` : "",
    turn.cause?.confidence ?? "",
    turn.interrupted ? "response cut off: output and cost are lower bounds" : "",
    declared?.intentional
      ? `declared by the harness${details(turn)}; ${declared.checked ? "the change is where the declaration allows" : "not checked (usage-only)"}`
      : "",
  ].filter(Boolean)
}

/** " (cut off)" for a call whose response ended early, else "". */
export function cutOffMark(turn: TurnResult): string {
  return turn.interrupted ? " (cut off)" : ""
}

/** "≥ " before a total that includes cut-off calls, whose output is a lower bound. */
export function atLeast(interrupted: number[]): string {
  return interrupted.length > 0 ? "≥ " : ""
}

/** How a report's cost totals are to be read: "at API list prices", and for subscription calls that it is a comparison. */
export function costBasis(billing: Analysis["summary"]["billing"]): string {
  const calls = billing.per_token + billing.subscription + billing.unknown
  if (billing.subscription === 0) return "at API list prices"
  if (billing.subscription === calls) return "at API list prices (subscription: a comparison, not billed)"
  return `at API list prices (${billing.subscription} of ${calls} calls on a subscription, not billed per token)`
}

export function shortModel(model: string): string {
  return model.length <= 22 ? model : `${model.slice(0, 21)}…`
}

function details(turn: TurnResult): string {
  const text = turn.declared_break!.declarations.flatMap((entry) => (entry.detail ? [entry.detail] : [])).join("; ")
  return text ? ` (${text})` : ""
}
