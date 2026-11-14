// What `prefixlens check` prints: the calls that fail, each with its cause, the changed block and
// the fix, then the counts.

import type { Check, MissClass } from "../check.ts"
import { escapeJsonControls, printable } from "../printable.ts"
import { exact, money } from "./format.ts"

export interface CheckRenderOptions {
  /** The trace, as named on the command line. */
  title?: string
}

const LABEL: Record<MissClass, string> = {
  avoidable: "avoidable miss",
  "undeclared-change": "undeclared prefix change",
  unexplained: "unexplained miss",
  intentional: "intentional break",
  expiry: "cache expiry",
  "provider-side": "provider-side miss",
  "cold-start": "cold start",
  "warm-start": "warm start",
  ok: "ok",
}

const DIFF_LINES = 14

export function renderCheck(check: Check, options: CheckRenderOptions = {}): string {
  const failing = check.calls.filter((call) => call.fails)
  const multiLane = new Set(check.calls.map((call) => `${call.session ?? ""}\u0000${call.lane}`)).size > 1
  const out = [`prefixlens check${options.title ? `: ${options.title}` : ""}`]
  const extra = check.fail_on.filter((name) => name !== "avoidable" && name !== "undeclared-change")
  out.push(
    failing.length > 0
      ? `FAIL: ${failing.length} of ${check.calls.length} ${check.calls.length === 1 ? "call" : "calls"}`
      : `ok: no call lost cached tokens for a reason the harness controls, and no prefix change is undeclared${extra.length > 0 ? `; none is a ${extra.map((name) => LABEL[name]).join(" or a ")} either` : ""}`,
  )
  for (const call of failing) {
    out.push("", `  turn ${call.turn}: ${LABEL[call.class]}${call.cause ? ` [${call.cause}]` : ""}, ${call.summary}`)
    const facts = [
      call.lost_tokens > 0 ? `lost ${exact(call.lost_tokens)} of ${exact(call.expected_cached_tokens)} cached tokens${call.miss_cost === null ? "" : ` (~${money(call.miss_cost)})`}` : "",
      call.baseline_turn === undefined ? "" : `vs turn ${call.baseline_turn}`,
      multiLane ? `lane ${call.lane}` : "",
    ].filter(Boolean)
    if (facts.length > 0) out.push(`    ${facts.join(" · ")}`)
    if (call.block) out.push(`    changed block: ${call.block}`)
    const lines = call.diff?.split("\n") ?? []
    for (const line of lines.slice(0, DIFF_LINES)) out.push(`    ${line}`)
    if (lines.length > DIFF_LINES) out.push(`    ... (${lines.length - DIFF_LINES} more lines in --json)`)
    if (call.fix) out.push(`    fix: ${call.fix}`)
  }
  const counted = (Object.keys(LABEL) as MissClass[]).filter((name) => check.counts[name] > 0).map((name) => `${check.counts[name]} ${LABEL[name]}`)
  out.push("", `${check.calls.length} ${check.calls.length === 1 ? "call" : "calls"}: ${counted.join(", ")}`)
  // Lanes, tool names and diffs come from the trace; this goes to a terminal and into CI logs.
  return printable(out.join("\n")) + "\n"
}

export function renderCheckJson(check: Check, options: { trace?: string } = {}): string {
  return escapeJsonControls(JSON.stringify({ check: "prefixlens", ...(options.trace ? { trace: options.trace } : {}), ...check }, null, 2)) + "\n"
}
