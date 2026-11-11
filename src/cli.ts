#!/usr/bin/env bun
// prefixlens command line: import harness logs into traces, and report on traces.

import os from "node:os"
import path from "node:path"
import { ADAPTERS, findAdapter } from "./adapters/index.ts"
import { analyze } from "./analyze.ts"
import { loadPricing } from "./pricing.ts"
import { renderHtml } from "./report/html.ts"
import { renderJson } from "./report/json.ts"
import { renderTerminal } from "./report/terminal.ts"
import { parseTrace, serializeTrace } from "./trace.ts"
import pkg from "../package.json" with { type: "json" }

const HELP = `prefixlens ${pkg.version}: explains prompt-cache hits and misses

Usage:
  prefixlens import <adapter> <path> [options]   convert harness logs to a trace (JSONL)
  prefixlens report <trace.jsonl|-> [options]    report hit rates, costs and miss causes
  prefixlens adapters                            list adapters and what they can diagnose

import options:
  -o, --out <file>      write the trace here (default: stdout)
  --session <id>        session to import, for stores holding many (opencode)
  --list                list sessions in the store instead of importing
  --no-subagents        leave out subagent sessions

report options:
  --json                print the report as JSON
  --html [file]         write a self-contained HTML report (default: <trace>.html)
  --pricing <file>      pricing table (default: $PREFIXLENS_PRICING or the bundled pricing.json)
  --tolerance <tokens>  lost tokens still counted as a hit (default 128)
  --all                 show every row and every miss in the terminal report
  --no-color            plain terminal output (also honours NO_COLOR)

Examples:
  prefixlens import claude-code ~/.claude/projects/-my-project/<session-id>.jsonl -o session.trace.jsonl
  prefixlens import opencode ~/.local/share/opencode/opencode.db --list
  prefixlens report session.trace.jsonl --html
`

type Flags = Record<string, string | true>

const VALUE_FLAGS = new Set(["out", "session", "pricing", "tolerance"])
const ALIASES: Record<string, string> = { o: "out", h: "help", v: "version" }

export async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.version) {
    console.log(pkg.version)
    return 0
  }
  const command = positionals[0]
  if (!command || flags.help || command === "help") {
    process.stdout.write(HELP)
    return command || flags.help ? 0 : 1
  }
  if (command === "adapters") return listAdapters()
  if (command === "import") return runImport(positionals.slice(1), flags)
  if (command === "report") return runReport(positionals.slice(1), flags)
  return fail(`unknown command "${command}"; run prefixlens --help`)
}

function parseArgs(argv: string[]) {
  const positionals: string[] = []
  const flags: Flags = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg)
      continue
    }
    const [rawName, inline] = arg.replace(/^--?/, "").split(/=(.*)/s, 2) as [string, string | undefined]
    const name = ALIASES[rawName] ?? rawName
    if (inline !== undefined) flags[name] = inline
    else if (VALUE_FLAGS.has(name)) flags[name] = argv[++index] ?? ""
    // --html takes an optional value: only an argument ending in .html is taken as its file.
    else if (name === "html" && argv[index + 1]?.endsWith(".html")) flags[name] = argv[++index]!
    else flags[name] = true
  }
  return { positionals, flags }
}

function listAdapters(): number {
  for (const adapter of ADAPTERS) {
    console.log(`${adapter.name}  (${adapter.fidelity})`)
    console.log(`  ${adapter.description}`)
    console.log(`  default location: ${adapter.defaultPath}`)
    console.log(`  ${adapter.diagnoses}`)
    console.log("")
  }
  return 0
}

async function runImport(args: string[], flags: Flags): Promise<number> {
  const [name, input] = args
  if (!name || !input) return fail("usage: prefixlens import <adapter> <path>  (adapters: " + ADAPTERS.map((a) => a.name).join(", ") + ")")
  const adapter = findAdapter(name)
  if (!adapter) return fail(`unknown adapter "${name}"; available: ${ADAPTERS.map((a) => a.name).join(", ")}`)
  const source = expandHome(input)
  if (flags.list) {
    if (!adapter.list) return fail(`the ${adapter.name} adapter imports one session file; --list is not needed`)
    for (const session of await adapter.list(source))
      console.log(`${session.id}  ${session.updated}${session.parent ? `  (subagent of ${session.parent})` : ""}  ${session.title ?? ""}`)
    return 0
  }
  const result = await adapter.import(source, {
    ...(typeof flags.session === "string" ? { session: flags.session } : {}),
    subagents: flags["no-subagents"] !== true,
  })
  for (const warning of result.warnings) console.error(`warning: ${warning}`)
  const text = serializeTrace(result.records)
  if (typeof flags.out === "string") {
    await Bun.write(flags.out, text)
    const full = result.records.filter((record) => record.fidelity === "full-request").length
    console.error(`wrote ${result.records.length} records (${full} full-request, ${result.records.length - full} usage-only) to ${flags.out}`)
  } else process.stdout.write(text)
  return 0
}

async function runReport(args: string[], flags: Flags): Promise<number> {
  const [input] = args
  if (!input) return fail("usage: prefixlens report <trace.jsonl|->")
  const text = input === "-" ? await Bun.stdin.text() : await readFile(expandHome(input))
  if (text === undefined) return fail(`cannot read ${input}`)
  const parsed = parseTrace(text)
  for (const error of parsed.errors.slice(0, 20)) console.error(`error: ${error}`)
  if (parsed.errors.length > 20) console.error(`error: ... ${parsed.errors.length - 20} more`)
  if (parsed.records.length === 0) return fail(parsed.errors.length > 0 ? "no valid trace records" : "the trace has no records (the import found no model calls with usage)")
  const pricingPath = typeof flags.pricing === "string" ? flags.pricing : undefined
  const pricing = await loadPricing(pricingPath)
  const tolerance = typeof flags.tolerance === "string" ? Number(flags.tolerance) : undefined
  if (tolerance !== undefined && !(Number.isFinite(tolerance) && tolerance >= 0)) return fail("--tolerance must be a non-negative number")
  const analysis = analyze(parsed.records, { pricing, ...(tolerance !== undefined ? { toleranceTokens: tolerance } : {}) })
  analysis.warnings.unshift(...parsed.warnings)
  const pricingSource = pricingPath ?? process.env.PREFIXLENS_PRICING ?? "bundled pricing.json"
  const pricingNote = `prices from ${pricingSource === "bundled pricing.json" ? "the bundled pricing.json" : pricingSource}${pricing.as_of ? ` (as of ${pricing.as_of})` : ""}`
  const title = input === "-" ? "stdin" : path.basename(input)
  if (flags.html) {
    const out = typeof flags.html === "string" ? flags.html : `${input === "-" ? "prefixlens-report" : input.replace(/\.jsonl?$/, "")}.html`
    await Bun.write(out, renderHtml(analysis, { title, pricingNote, generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" }))
    console.error(`wrote ${out}`)
  }
  if (flags.json) process.stdout.write(renderJson(analysis, { trace: input, pricing: { source: pricingSource, ...(pricing.as_of ? { as_of: pricing.as_of } : {}) } }))
  else if (!flags.html)
    process.stdout.write(
      renderTerminal(analysis, {
        color: flags["no-color"] !== true && !process.env.NO_COLOR && process.stdout.isTTY === true,
        all: flags.all === true,
        title,
        pricingNote,
      }),
    )
  return 0
}

async function readFile(file: string): Promise<string | undefined> {
  const handle = Bun.file(file)
  return (await handle.exists()) ? handle.text() : undefined
}

function expandHome(file: string): string {
  return file === "~" || file.startsWith("~/") ? path.join(os.homedir(), file.slice(1)) : file
}

function fail(message: string): number {
  console.error(`prefixlens: ${message}`)
  return 1
}

if (import.meta.main) {
  // Set the exit code instead of calling process.exit so piped output is flushed first.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error(`prefixlens: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}

