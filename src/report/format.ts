// Shared formatting for the reports.

import { money } from "../analyze.ts"
import type { Status, TurnResult } from "../analyze.ts"

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

export function isMiss(turn: TurnResult): boolean {
  return turn.status === "miss" || turn.status === "partial"
}

/** "turn 41: miss, tool list changed (+2 tools), ~$0.38" */
export function missLine(turn: TurnResult): string {
  const cost = turn.miss_cost === null ? "" : `, ~${money(turn.miss_cost)}`
  return `turn ${turn.turn}: ${STATUS_LABEL[turn.status]}, ${turn.cause?.summary ?? "cause unknown"}${cost}`
}

export function shortModel(model: string): string {
  return model.length <= 22 ? model : `${model.slice(0, 21)}…`
}
