// A single self-contained HTML file: inline CSS, inline SVG chart, a few lines
// of inline script for filtering. No external requests.

import type { Analysis, TurnResult } from "../analyze.ts"
import { atLeast, clock, costBasis, cutOffMark, exact, intentionalLabel, isIntentional, isMiss, missFacts, missLine, money, percent, spansDays, statusLabel, tokens } from "./format.ts"

export interface HtmlOptions {
  title?: string
  pricingNote?: string
  generatedAt?: string
}

export function renderHtml(analysis: Analysis, options: HtmlOptions = {}): string {
  const summary = analysis.summary
  const misses = analysis.turns.filter(isMiss)
  const intentional = analysis.turns.filter(isIntentional)
  const title = options.title ? `prefixlens: ${options.title}` : "prefixlens report"
  const multiLane = summary.lanes.length > 1
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <h1>${escape(title)}</h1>
  <p class="sub">${exact(summary.turns)} model calls · ${summary.lanes.length} ${summary.lanes.length === 1 ? "lane" : "lanes"} · ${exact(summary.fidelity.full_request)} full-request, ${exact(summary.fidelity.usage_only)} usage-only${options.generatedAt ? ` · generated ${escape(options.generatedAt)}` : ""}</p>
  <p class="headline">${escape(summary.headline)}</p>
</header>

<section class="cards">
  ${card("Cache hit rate", percent(summary.hit_rate), `${tokens(summary.tokens.cache_read)} of ${tokens(summary.tokens.prompt)} prompt tokens read from cache`)}
  ${card("Cost at list prices", summary.cost ? `${atLeast(summary.interrupted)}${money(summary.cost.total)}` : "n/a", summary.cost ? `${money(summary.cost.uncached)} on uncached input and cache writes; ${summary.billing.subscription > 0 ? costBasis(summary.billing) : "API list prices, not what was paid"}` : "some models are not in the pricing table")}
  ${card("Lost to misses", summary.cost ? money(summary.cost.misses) : "n/a", `${summary.misses} ${summary.misses === 1 ? "call" : "calls"} missed cached tokens unexpectedly`)}
  ${summary.intentional.breaks > 0 ? card("Intentional breaks", summary.cost ? money(summary.cost.intentional) : "n/a", `${summary.intentional.breaks} declared by the harness: ${summary.intentional.by_reason.map((reason) => `${reason.breaks} ${reason.reason}`).join(", ")}`, "intentional") : ""}
  ${card("Calls", exact(summary.turns), `${summary.status.cold} cold · ${summary.status.hit} hit · ${summary.misses} missed${summary.intentional.breaks > 0 ? ` · ${summary.intentional.breaks} intentional` : ""}`)}
  ${summary.reported_cost !== undefined ? card("Harness-reported cost", money(summary.reported_cost), "as recorded in the session log") : ""}
</section>

${summary.notes.length + (options.pricingNote ? 1 : 0) > 0 ? `<section class="notes">${[...summary.notes, ...(options.pricingNote ? [options.pricingNote] : [])].map((note) => `<p>${escape(note)}</p>`).join("")}</section>` : ""}

<section>
  <h2>Prompt tokens per call</h2>
  ${chart(analysis.turns)}
  <p class="legend"><span class="sw read"></span>read from cache <span class="sw write"></span>written to cache <span class="sw input"></span>uncached input <span class="sw missmark"></span>miss <span class="sw intentmark"></span>intentional break</p>
</section>

${summary.by_group.length > 0 ? `<section>
  <h2>Misses by cause</h2>
  <table class="groups"><thead><tr><th>cause</th><th class="n">misses</th><th class="n">cost</th></tr></thead><tbody>
  ${summary.by_group.map((group) => `<tr><td>${escape(group.group)}</td><td class="n">${group.misses}</td><td class="n">${summary.cost ? money(group.cost) : "-"}</td></tr>`).join("")}
  </tbody></table>
</section>` : ""}

${misses.length > 0 ? `<section>
  <h2>Misses</h2>
  ${misses.map((turn) => missDetail(turn, multiLane)).join("\n")}
</section>` : ""}

${intentional.length > 0 ? `<section>
  <h2>Intentional breaks</h2>
  <p class="legend">Declared by the harness (a compaction, a revert, a model or setting change). Their cost is shown here and not counted as misses.</p>
  ${summary.intentional.by_reason.length > 0 ? `<table class="groups"><thead><tr><th>reason</th><th class="n">breaks</th><th class="n">cost</th></tr></thead><tbody>
  ${summary.intentional.by_reason.map((reason) => `<tr><td>${escape(reason.reason)}</td><td class="n">${reason.breaks}</td><td class="n">${summary.cost ? money(reason.cost) : "-"}</td></tr>`).join("")}
  </tbody></table>` : ""}
  ${intentional.map((turn) => missDetail(turn, multiLane)).join("\n")}
</section>` : ""}

<section>
  <h2>All calls</h2>
  <label class="filter"><input type="checkbox" id="only-misses"> show only misses, intentional breaks and cold starts</label>
  <div class="scroll">
  <table class="turns" id="turns">
    <thead><tr><th class="n">turn</th><th>time (UTC)</th>${multiLane ? "<th>lane</th>" : ""}<th>model</th><th class="n">prompt</th><th class="n">read</th><th class="n">write</th><th class="n">uncached</th><th class="n">out</th><th class="n">hit</th><th class="n">cost</th><th>status</th></tr></thead>
    <tbody>
    ${analysis.turns.map((turn) => row(turn, multiLane, spansDays(analysis.turns))).join("\n")}
    </tbody>
  </table>
  </div>
</section>

${analysis.warnings.length > 0 ? `<section class="notes"><h2>Warnings</h2>${analysis.warnings.map((warning) => `<p>${escape(warning)}</p>`).join("")}</section>` : ""}
<footer>Generated by prefixlens. Hit rate = tokens read from cache ÷ prompt tokens. A miss is a call that read fewer tokens from cache than the previous call in its lane left there.</footer>
</main>
<script>
document.getElementById("only-misses").addEventListener("change", function (event) {
  for (const row of document.querySelectorAll("#turns tbody tr"))
    row.hidden = event.target.checked && row.dataset.status === "hit";
});
</script>
</body>
</html>
`
}

function card(label: string, value: string, note: string, kind = ""): string {
  return `<div class="card${kind ? ` ${kind}` : ""}"><div class="label">${escape(label)}</div><div class="value">${escape(value)}</div><div class="note">${escape(note)}</div></div>`
}

function missDetail(turn: TurnResult, multiLane: boolean): string {
  const facts = [
    ...missFacts(turn, multiLane),
    turn.cause?.block_index !== undefined ? `first changed block: #${turn.cause.block_index + 1} of the request (${turn.cause.region})` : "",
  ].filter(Boolean)
  const note = turn.declared_break?.note && !turn.declared_break.intentional ? `<p class="facts warn">not excused: ${escape(turn.declared_break.note)}</p>` : ""
  return `<details class="miss ${isIntentional(turn) ? "intentional" : turn.status}" id="turn-${turn.turn}"${turn.cause?.diff && !isIntentional(turn) ? " open" : ""}>
  <summary>${escape(missLine(turn))}</summary>
  <p class="facts">${escape(facts.join(" · "))}</p>${note}
  ${turn.cause?.diff ? `<pre class="diff">${turn.cause.diff.split("\n").map(diffLine).join("")}</pre>` : ""}
</details>`
}

function diffLine(line: string): string {
  const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx"
  return `<span class="${kind}">${escape(line)}</span>`
}

function row(turn: TurnResult, multiLane: boolean, withDate: boolean): string {
  const intentional = isIntentional(turn)
  const label = `${intentional ? intentionalLabel(turn) : statusLabel(turn)}${cutOffMark(turn)}`
  const status = intentional || isMiss(turn) ? `${label}: ${turn.cause?.summary ?? ""}` : label
  const cost = turn.cost ? money(turn.cost.total) : turn.usage.reported_cost !== undefined ? `${money(turn.usage.reported_cost)}*` : "-"
  const statusCell = isMiss(turn) || intentional ? `<a href="#turn-${turn.turn}">${escape(status)}</a>` : escape(status)
  return `<tr class="${intentional ? "intentional" : turn.status}" data-status="${turn.status}"><td class="n">${turn.turn}</td><td>${clock(turn.ts, withDate)}</td>${multiLane ? `<td>${escape(turn.lane)}</td>` : ""}<td>${escape(turn.model)}</td><td class="n">${exact(turn.prompt_tokens)}</td><td class="n">${exact(turn.usage.cache_read_tokens)}</td><td class="n">${turn.usage.cache_write_tokens === null ? "-" : exact(turn.usage.cache_write_tokens)}</td><td class="n">${exact(turn.usage.input_tokens)}</td><td class="n">${exact(turn.usage.output_tokens)}</td><td class="n">${percent(turn.hit_rate)}</td><td class="n">${cost}</td><td>${statusCell}</td></tr>`
}

/** Stacked bars of read / write / uncached tokens; long traces are bucketed so the chart stays readable. */
function chart(turns: TurnResult[]): string {
  if (turns.length === 0) return "<p>No calls.</p>"
  const width = 960
  const height = 180
  const bucketSize = Math.max(1, Math.ceil(turns.length / 480))
  const buckets = Array.from({ length: Math.ceil(turns.length / bucketSize) }, (_, index) => turns.slice(index * bucketSize, (index + 1) * bucketSize))
  const values = buckets.map((bucket) => ({
    read: Math.max(...bucket.map((turn) => turn.usage.cache_read_tokens)),
    write: Math.max(...bucket.map((turn) => turn.usage.cache_write_tokens ?? 0)),
    input: Math.max(...bucket.map((turn) => turn.usage.input_tokens)),
    prompt: Math.max(...bucket.map((turn) => turn.prompt_tokens)),
    miss: bucket.some(isMiss),
    intentional: bucket.some(isIntentional),
    first: bucket[0]!.turn,
    last: bucket.at(-1)!.turn,
  }))
  const max = Math.max(1, ...values.map((value) => value.prompt))
  const step = width / values.length
  const bar = Math.max(1, step * 0.8)
  const scale = (value: number) => (value / max) * (height - 14)
  const bars = values
    .map((value, index) => {
      const x = (index * step).toFixed(2)
      // Bucketed bars show the largest call in the bucket; segments use that call's proportions.
      const total = value.read + value.write + value.input || 1
      const h = scale(value.prompt)
      const read = (h * value.read) / total
      const write = (h * value.write) / total
      const input = h - read - write
      const label = value.first === value.last ? `turn ${value.first}` : `turns ${value.first}-${value.last}`
      return `<g><title>${label}: ${exact(value.prompt)} prompt tokens</title>` +
        `<rect class="read" x="${x}" y="${(height - read).toFixed(2)}" width="${bar.toFixed(2)}" height="${read.toFixed(2)}"/>` +
        `<rect class="write" x="${x}" y="${(height - read - write).toFixed(2)}" width="${bar.toFixed(2)}" height="${write.toFixed(2)}"/>` +
        `<rect class="input" x="${x}" y="${(height - h).toFixed(2)}" width="${bar.toFixed(2)}" height="${Math.max(0, input).toFixed(2)}"/>` +
        (value.miss
          ? `<rect class="missmark" x="${x}" y="0" width="${bar.toFixed(2)}" height="6"/>`
          : value.intentional
            ? `<rect class="intentmark" x="${x}" y="0" width="${bar.toFixed(2)}" height="6"/>`
            : "") +
        `</g>`
    })
    .join("")
  const note = bucketSize > 1 ? `<p class="legend">Each bar is the largest of ${bucketSize} consecutive calls.</p>` : ""
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Prompt tokens per call">${bars}</svg>${note}`
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
}

const CSS = `
:root { --bg: #ffffff; --fg: #1d2023; --muted: #5d6670; --line: #dde1e5; --card: #f5f7f9;
  --read: #3f8f5f; --write: #d08a2e; --input: #8a95a1; --miss: #c8433b; --partial: #b7791f; --cold: #3a78b5; --intent: #6b5bd2;
  --add-bg: #e6f4ea; --del-bg: #fbe9e7; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #15181b; --fg: #e6e8ea; --muted: #9aa3ad; --line: #2c3238; --card: #1d2125;
  --read: #5bb37f; --write: #e0a04a; --input: #7c8792; --miss: #ef6b62; --partial: #d9a441; --cold: #6aa6df; --intent: #9d8ff0; --add-bg: #1d3325; --del-bg: #3a2220; } }
:root[data-theme="dark"] { --bg: #15181b; --fg: #e6e8ea; --muted: #9aa3ad; --line: #2c3238; --card: #1d2125;
  --read: #5bb37f; --write: #e0a04a; --input: #7c8792; --miss: #ef6b62; --partial: #d9a441; --cold: #6aa6df; --intent: #9d8ff0; --add-bg: #1d3325; --del-bg: #3a2220; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 16px; margin: 28px 0 10px; }
.sub, .legend, .facts, footer, .note, .label { color: var(--muted); }
.headline { font-size: 17px; font-weight: 600; margin: 12px 0 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-top: 20px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card .label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.card .value { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
.card .note { font-size: 12px; }
.notes p { margin: 6px 0; padding: 8px 12px; background: var(--card); border-left: 3px solid var(--partial); border-radius: 4px; }
.chart { width: 100%; height: 180px; display: block; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.chart .read, .sw.read { fill: var(--read); background: var(--read); }
.chart .write, .sw.write { fill: var(--write); background: var(--write); }
.chart .input, .sw.input { fill: var(--input); background: var(--input); }
.chart .missmark, .sw.missmark { fill: var(--miss); background: var(--miss); }
.chart .intentmark, .sw.intentmark { fill: var(--intent); background: var(--intent); }
.card.intentional { border-left: 4px solid var(--intent); }
.sw { display: inline-block; width: 10px; height: 10px; margin: 0 4px 0 12px; border-radius: 2px; vertical-align: -1px; }
.sw:first-child { margin-left: 0; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td:last-child { white-space: normal; min-width: 240px; }
th { font-weight: 600; color: var(--muted); font-size: 12px; }
.n { text-align: right; }
.scroll { overflow-x: auto; }
table.groups { width: auto; min-width: 360px; }
tr.hit td { color: var(--muted); }
tr.miss td:last-child, tr.miss td:last-child a { color: var(--miss); font-weight: 600; }
tr.partial td:last-child, tr.partial td:last-child a { color: var(--partial); font-weight: 600; }
tr.cold td:last-child { color: var(--cold); }
details.miss { border: 1px solid var(--line); border-left: 4px solid var(--miss); border-radius: 6px; padding: 8px 12px; margin: 8px 0; background: var(--card); }
details.miss.partial { border-left-color: var(--partial); }
details.miss.intentional { border-left-color: var(--intent); }
tr.intentional td:last-child, tr.intentional td:last-child a { color: var(--intent); }
.facts.warn { color: var(--partial); }
details.miss summary { cursor: pointer; font-weight: 600; overflow-wrap: anywhere; }
.facts { margin: 6px 0; font-size: 13px; }
pre.diff { margin: 8px 0 0; padding: 8px; overflow-x: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre.diff span { display: block; white-space: pre; }
pre.diff .add { background: var(--add-bg); }
pre.diff .del { background: var(--del-bg); }
pre.diff .ctx { color: var(--muted); }
.filter { display: block; margin-bottom: 8px; color: var(--muted); }
a { color: inherit; }
footer { margin-top: 32px; font-size: 12px; }
`
