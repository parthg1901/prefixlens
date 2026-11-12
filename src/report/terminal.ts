// Plain-text report for the terminal.

import type { Analysis, TurnResult } from "../analyze.ts"
import { atLeast, clock, cutOffMark, exact, intentionalLabel, isIntentional, isMiss, missFacts, missLine, money, percent, shortModel, spansDays, STATUS_LABEL, tokens } from "./format.ts"

export interface TerminalOptions {
  color?: boolean
  /** Show every row and every miss, however long the trace. */
  all?: boolean
  title?: string
  pricingNote?: string
}

const ROW_LIMIT = 60
const MISS_LIMIT = 40
const DIFF_LINES = 14

export function renderTerminal(analysis: Analysis, options: TerminalOptions = {}): string {
  const paint = painter(options.color ?? false)
  const summary = analysis.summary
  const out: string[] = []
  const multiLane = summary.lanes.length > 1
  const withDate = spansDays(analysis.turns)

  out.push(paint.bold(`prefixlens report${options.title ? `: ${options.title}` : ""}`))
  out.push(
    `${exact(summary.turns)} model calls · ${summary.lanes.length} ${summary.lanes.length === 1 ? "lane" : "lanes"} · ` +
      `${exact(summary.fidelity.full_request)} full-request, ${exact(summary.fidelity.usage_only)} usage-only`,
  )
  out.push("")

  const rows = options.all || analysis.turns.length <= ROW_LIMIT ? analysis.turns : analysis.turns.filter((turn) => turn.status !== "hit")
  const header = ["turn", "time (UTC)", ...(multiLane ? ["lane"] : []), "model", "prompt", "read", "write", "uncached", "out", "hit", "cost", "status"]
  const body = rows.map((turn) => [
    String(turn.turn),
    clock(turn.ts, withDate),
    ...(multiLane ? [laneLabel(turn.lane)] : []),
    shortModel(turn.model),
    tokens(turn.prompt_tokens),
    tokens(turn.usage.cache_read_tokens),
    turn.usage.cache_write_tokens === null ? "-" : tokens(turn.usage.cache_write_tokens),
    tokens(turn.usage.input_tokens),
    tokens(turn.usage.output_tokens),
    percent(turn.hit_rate),
    turn.cost ? money(turn.cost.total) : turn.usage.reported_cost !== undefined ? `${money(turn.usage.reported_cost)}*` : "-",
    statusText(turn),
  ])
  out.push(...table(header, body, header.length - 1, (row, index) => colorRow(paint, rows[index]!, row)))
  if (rows.length < analysis.turns.length)
    out.push(paint.dim(`(${exact(analysis.turns.length - rows.length)} hit rows hidden; --all shows every row)`))
  if (rows.some((turn) => !turn.cost && turn.usage.reported_cost !== undefined)) out.push(paint.dim("* cost reported by the harness; model not in the pricing table"))
  out.push("")

  const detail = (turn: TurnResult, color: (text: string) => string) => {
    out.push(`  ${color(missLine(turn))}`)
    out.push(paint.dim(`    ${missFacts(turn, multiLane, laneLabel).join(" · ")}`))
    if (turn.declared_break?.note && !turn.declared_break.intentional) out.push(paint.yellow(`    not excused: ${turn.declared_break.note}`))
    if (turn.cause?.diff) {
      const lines = turn.cause.diff.split("\n")
      for (const line of lines.slice(0, DIFF_LINES)) out.push(`    ${colorDiff(paint, line)}`)
      if (lines.length > DIFF_LINES) out.push(paint.dim(`    ... (${lines.length - DIFF_LINES} more lines in --json / --html)`))
    }
  }
  const misses = analysis.turns.filter(isMiss)
  if (misses.length > 0) {
    out.push(paint.bold("Misses"))
    const shown = options.all ? misses : misses.toSorted((a, b) => (b.miss_cost ?? 0) - (a.miss_cost ?? 0)).slice(0, MISS_LIMIT).toSorted((a, b) => a.turn - b.turn)
    for (const turn of shown) detail(turn, paint[turn.status === "miss" ? "red" : "yellow"])
    if (shown.length < misses.length) out.push(paint.dim(`  (${misses.length - shown.length} smaller misses not shown; --all shows every miss)`))
    out.push("")
  }

  const intentional = analysis.turns.filter(isIntentional)
  if (intentional.length > 0) {
    out.push(`${paint.bold("Intentional breaks")} ${paint.dim("(declared by the harness; their cost is shown, not counted as misses)")}`)
    const shown = options.all ? intentional : intentional.slice(0, MISS_LIMIT)
    for (const turn of shown) detail(turn, paint.blue)
    if (shown.length < intentional.length) out.push(paint.dim(`  (${intentional.length - shown.length} more not shown; --all shows every one)`))
    out.push("")
  }

  out.push(paint.bold("Totals"))
  const t = summary.tokens
  out.push(`  prompt tokens   ${exact(t.prompt)}  (read ${exact(t.cache_read)} · written ${exact(t.cache_write)} · uncached ${exact(t.input)})`)
  out.push(`  output tokens   ${atLeast(summary.interrupted)}${exact(t.output)}`)
  out.push(`  cache hit rate  ${percent(summary.hit_rate)} of prompt tokens read from cache`)
  if (summary.cost)
    out.push(
      `  cost            ${atLeast(summary.interrupted)}${money(summary.cost.total)} at API list prices · ${money(summary.cost.uncached)} on uncached input and cache writes · ${money(summary.cost.misses)} lost to misses${summary.intentional.breaks > 0 ? ` · ${money(summary.cost.intentional)} on intentional breaks` : ""}`,
    )
  if (summary.reported_cost !== undefined) out.push(`  harness cost    ${money(summary.reported_cost)} as recorded by the harness`)
  out.push(
    `  calls           ${[
      `${summary.status.cold} cold`,
      `${summary.status.hit} hit`,
      `${summary.status.partial - intentional.filter((turn) => turn.status === "partial").length} partial`,
      `${summary.status.miss - intentional.filter((turn) => turn.status === "miss").length} miss`,
      ...(intentional.length > 0 ? [`${intentional.length} intentional break${intentional.length === 1 ? "" : "s"}`] : []),
      ...(summary.status.uncached > 0 ? [`${summary.status.uncached} no cache`] : []),
    ].join(" · ")}`,
  )
  if (summary.by_group.length > 0) {
    out.push("  misses by cause")
    for (const group of summary.by_group)
      out.push(`    ${group.group.padEnd(28)} ${String(group.misses).padStart(5)}  ${summary.cost ? money(group.cost) : ""}`)
  }
  if (summary.intentional.breaks > 0) {
    out.push("  intentional breaks by reason")
    for (const reason of summary.intentional.by_reason)
      out.push(`    ${reason.reason.padEnd(28)} ${String(reason.breaks).padStart(5)}  ${summary.cost ? money(reason.cost) : ""}`)
  }
  out.push("")
  out.push(paint.bold(summary.headline))
  for (const note of [...summary.notes, ...(options.pricingNote ? [options.pricingNote] : [])]) out.push(paint.dim(`note: ${note}`))
  for (const warning of analysis.warnings.slice(0, 10)) out.push(paint.yellow(`warning: ${warning}`))
  return out.join("\n") + "\n"
}

function statusText(turn: TurnResult): string {
  if (isIntentional(turn)) return `${intentionalLabel(turn)}${cutOffMark(turn)}: ${turn.cause?.summary ?? "cause unknown"}`
  if (!isMiss(turn)) return `${STATUS_LABEL[turn.status]}${cutOffMark(turn)}`
  return `${STATUS_LABEL[turn.status]}${cutOffMark(turn)}: ${turn.cause?.summary ?? "cause unknown"}`
}

function laneLabel(lane: string): string {
  const last = lane.split("/").pop() ?? lane
  return last.length <= 14 ? last : `${last.slice(0, 13)}…`
}

function table(header: string[], rows: string[][], freeColumn: number, paintRow: (row: string, index: number) => string): string[] {
  const widths = header.map((title, column) => (column === freeColumn ? 0 : Math.max(title.length, ...rows.map((row) => row[column]!.length))))
  const numeric = new Set(["turn", "prompt", "read", "write", "uncached", "out", "hit", "cost"])
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => (column === freeColumn ? cell : numeric.has(header[column]!) ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!)))
      .join("  ")
  return [line(header), ...rows.map((row, index) => paintRow(line(row), index))]
}

function colorRow(paint: Painter, turn: TurnResult, row: string): string {
  if (isIntentional(turn)) return paint.blue(row)
  if (turn.status === "miss") return paint.red(row)
  if (turn.status === "partial") return paint.yellow(row)
  if (turn.status === "cold") return paint.cyan(row)
  return paint.dim(row)
}

function colorDiff(paint: Painter, line: string): string {
  if (line.startsWith("+")) return paint.green(line)
  if (line.startsWith("-")) return paint.red(line)
  return paint.dim(line)
}

type Painter = Record<"bold" | "dim" | "red" | "green" | "yellow" | "cyan" | "blue", (text: string) => string>

function painter(enabled: boolean): Painter {
  const wrap = (open: number, close: number) => (text: string) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text)
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), blue: wrap(34, 39) }
}
