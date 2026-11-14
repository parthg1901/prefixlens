#!/usr/bin/env bun
// prefixlens command line: import harness logs into traces, and report on traces.

import { realpathSync } from "node:fs"
import { open, readFile as readText, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { text as streamText } from "node:stream/consumers"
import { fileURLToPath } from "node:url"
import { ADAPTERS, findAdapter } from "./adapters/index.ts"
import { analyze } from "./analyze.ts"
import { classifyMisses, isHarnessCause, MISS_CLASSES, type MissClass } from "./check.ts"
import { CAUSE_GROUP, type Cause } from "./diff.ts"
import { cataloguePath, loadCatalogue, parseProviderMapping } from "./catalogue.ts"
import { loadPricing } from "./pricing.ts"
import { printable } from "./printable.ts"
import { renderCheck, renderCheckJson } from "./report/check.ts"
import { renderHtml } from "./report/html.ts"
import { renderJson } from "./report/json.ts"
import { renderTerminal } from "./report/terminal.ts"
import { createTraceEncoder, parseTrace, readableByOthers, writePrivateFile } from "./trace.ts"
import { promptTokens } from "./usage.ts"
import { VERSION } from "./version.ts"

const HELP = `prefixlens ${VERSION}: explains prompt-cache hits and misses

Usage:
  prefixlens import <adapter> <path> [options]   convert harness logs to a trace (JSONL)
  prefixlens report <trace.jsonl|-> [options]    report hit rates, costs and miss causes
  prefixlens check <trace.jsonl|-> [options]     exit 1 when the harness broke its own cache (for CI)
  prefixlens record --provider <p> [options]     run a local proxy that records every model call
  prefixlens adapters                            list adapters and what they can diagnose
  prefixlens pricing update [--from <file>]      fetch models.dev prices into the user cache (network)
  prefixlens pricing check [--from <file>]       list where models.dev disagrees with the pricing table (network)
  prefixlens pricing show <model> [options]      which price a model gets, from which source and date

import options:
  -o, --out <file>      write the trace here (default: stdout)
  --session <id>        session to import, for stores holding many (opencode)
  --list                list sessions in the store instead of importing
  --no-subagents        leave out subagent sessions

record options:
  --provider <name>     anthropic or openai (required)
  --port <n>            port to listen on (default 8787)
  --host <address>      address to listen on (default 127.0.0.1)
  -o, --out <file>      trace to append to (default prefixlens.trace.jsonl)
  --upstream <url>      where to forward (default https://api.anthropic.com or https://api.openai.com)
  --allow-origin <o>    do not refuse requests with these Origin values (comma-separated, or *)
  --keep-identifiers    keep metadata, user, safety_identifier and client_metadata in params
  --keep-binary         keep base64 images, documents and audio instead of their SHA-256 and size
  --quiet               do not print a line per recorded call

report options:
  --json                print the report as JSON
  --html [file]         write a self-contained HTML report (default: <trace>.html)
  --pricing <file>      pricing table (default: $PREFIXLENS_PRICING or the bundled pricing.json)
  --no-catalogue        do not use the models.dev prices fetched by prefixlens pricing update
  --catalogue-provider <trace>=<models.dev>[,...]
                        price a trace provider's models the table lacks from another models.dev
                        provider, e.g. anthropic=openrouter (default: each provider's own)
  --tolerance <tokens>  lost tokens still counted as a hit (default 128)
  --all                 show every row and every miss in the terminal report
  --no-color            plain terminal output (also honours NO_COLOR)

check options:
  --fail-on <classes>   also fail on these, comma-separated: unexplained, intentional, expiry,
                        provider-side, cold-start, warm-start (default: avoidable misses and
                        undeclared prefix changes only)
  --allow <causes>      causes that are intentional in this trace, comma-separated, e.g. compaction
  --json                print the verdict for every call, and the counts, as JSON
  --pricing, --no-catalogue, --catalogue-provider, --tolerance   as for report
  exit codes: 0 pass, 1 a call fails, 2 the trace could not be checked

pricing options:
  --from <file>         read a saved copy of https://models.dev/api.json instead of fetching it
  --pricing <file>      the table to compare with or look in (default: as for report)
  --provider <name>     show: the trace provider (inferred for claude, gpt, o-series and gemini ids)
  --date <YYYY-MM-DD>   show: the day of the call (default: today)
  --catalogue-provider, --no-catalogue   as for report
  --json                check: print the comparison as JSON
  --all                 update, check: list every change, not the first 20
  update and check (without --from) make one HTTP GET to https://models.dev/api.json; report never fetches.
  update writes ${cataloguePath().replace(os.homedir(), "~")}; delete it to stop using catalogue prices.

Examples:
  prefixlens import claude-code ~/.claude/projects/-my-project/<session-id>.jsonl -o session.trace.jsonl
  prefixlens import opencode ~/.local/share/opencode/opencode.db --list
  prefixlens report session.trace.jsonl --html
  prefixlens check run.trace.jsonl --fail-on expiry           # in CI, after a recorded run
  prefixlens record --provider anthropic -o run.trace.jsonl   # then ANTHROPIC_BASE_URL=http://127.0.0.1:8787
`

type Flags = Record<string, string | true>

const VALUE_FLAGS = new Set(["out", "session", "pricing", "tolerance", "provider", "port", "host", "upstream", "allow-origin", "from", "date", "catalogue-provider", "fail-on", "allow"])
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, "list", "no-subagents", "json", "html", "all", "no-color", "no-catalogue", "keep-identifiers", "keep-binary", "quiet", "help", "version"])
const ALIASES: Record<string, string> = { o: "out", h: "help", v: "version" }

export async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv)
  const unknown = Object.keys(flags).find((name) => !KNOWN_FLAGS.has(name))
  if (unknown) return fail(`unknown option --${unknown}; run prefixlens --help`)
  const empty = [...VALUE_FLAGS].find((name) => flags[name] === "")
  if (empty) return fail(`--${empty} needs a value`)
  if (flags.version) {
    console.log(VERSION)
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
  if (command === "check") return runCheck(positionals.slice(1), flags)
  if (command === "record") return runRecord(flags)
  if (command === "pricing") {
    const mapping = typeof flags["catalogue-provider"] === "string" ? parseProviderMapping(flags["catalogue-provider"]) : undefined
    const { runPricing } = await import("./pricing-command.ts")
    return runPricing(positionals[1], positionals.slice(2), {
      ...(typeof flags.from === "string" ? { from: expandHome(flags.from) } : {}),
      ...(typeof flags.pricing === "string" ? { pricing: flags.pricing } : {}),
      ...(typeof flags.provider === "string" ? { provider: flags.provider } : {}),
      ...(typeof flags.date === "string" ? { date: flags.date } : {}),
      ...(mapping ? { catalogueProviders: mapping } : {}),
      json: flags.json === true,
      all: flags.all === true,
      noCatalogue: flags["no-catalogue"] === true,
    })
  }
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
  if (!(await stat(source).catch(() => undefined))) return fail(`cannot read ${input}: no such file or directory`)
  if (flags.list) {
    if (!adapter.list) return fail(`the ${adapter.name} adapter imports one session file; --list is not needed`)
    for (const session of await adapter.list(source))
      console.log(printable(`${session.id}  ${session.updated}${session.parent ? `  (subagent of ${session.parent})` : ""}  ${session.title ?? ""}`))
    return 0
  }
  const result = await adapter.import(source, {
    ...(typeof flags.session === "string" ? { session: flags.session } : {}),
    subagents: flags["no-subagents"] !== true,
    contentOnDemand: true,
  })
  for (const warning of result.warnings) console.error(printable(`warning: ${warning}`))
  if (result.records.length === 0) return fail(`no model calls with usage found in ${input}; nothing written`)
  // Line by line, each block's content read back from the harness's files as it is first written.
  const encoder = createTraceEncoder(result.content ? { content: result.content } : {})
  const records = result.records
  const lines = (function* () {
    for (const record of records) yield `${encoder.encode(record)}\n`
  })()
  if (typeof flags.out === "string") {
    const shared = readableByOthers(flags.out)
    await writeLines(flags.out, lines)
    if (shared) console.error(`warning: ${flags.out} already existed and other users can read it; its permissions were kept (chmod 600 to make it private)`)
    const full = result.records.filter((record) => record.fidelity === "full-request").length
    const verified = result.records.filter((record) => record.source?.request === "verified").length
    const check = verified > 0 ? `; ${verified} matched the digest the harness logged of the request it built` : ""
    console.error(`wrote ${result.records.length} records (${full} full-request, ${result.records.length - full} usage-only${check}) to ${flags.out}`)
  } else for (const line of lines) if (!process.stdout.write(line)) await new Promise((resolve) => process.stdout.once("drain", resolve))
  return 0
}

/** Writes lines to a new private file (or replaces one, keeping its mode) as they are produced. */
async function writeLines(file: string, lines: Iterable<string>) {
  writePrivateFile(file, "")
  const handle = await open(file, "w")
  try {
    for (const line of lines) await handle.write(line)
  } finally {
    await handle.close()
  }
}

async function runReport(args: string[], flags: Flags): Promise<number> {
  const [input] = args
  if (!input) return fail("usage: prefixlens report <trace.jsonl|->")
  const loaded = await loadAnalysis(input, flags)
  if (typeof loaded === "string") return fail(loaded)
  const { analysis, pricing, pricingSource, catalogue } = loaded
  const usesCatalogue = analysis.turns.some((turn) => turn.priced === "catalogue")
  const pricingNote = `prices from ${pricingSource === "bundled pricing.json" ? "the bundled pricing.json" : pricingSource}${pricing.as_of ? ` (as of ${pricing.as_of})` : ""}${catalogue && usesCatalogue ? `, then models.dev (fetched ${catalogue.fetched_at.slice(0, 10)}) for models it does not list` : ""}`
  const title = input === "-" ? "stdin" : path.basename(input)
  if (flags.html) {
    const out = typeof flags.html === "string" ? flags.html : `${input === "-" ? "prefixlens-report" : input.replace(/\.jsonl?$/, "")}.html`
    writePrivateFile(out, renderHtml(analysis, { title, pricingNote, generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" }))
    console.error(`wrote ${out}`)
  }
  if (flags.json) process.stdout.write(renderJson(analysis, { trace: input, pricing: { source: pricingSource, ...(pricing.as_of ? { as_of: pricing.as_of } : {}), ...(catalogue ? { catalogue: { source: "models.dev", fetched_at: catalogue.fetched_at } } : {}) } }))
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

// The CI gate: the report's analysis, sorted into classes, with an exit code. 2 means the check could not be made.
async function runCheck(args: string[], flags: Flags): Promise<number> {
  const [input] = args
  if (!input) return fail("usage: prefixlens check <trace.jsonl|-> [--fail-on <classes>] [--allow <causes>] [--json]", 2)
  const list = (flag: string | true | undefined) => (typeof flag === "string" ? flag.split(",").map((name) => name.trim()).filter(Boolean) : [])
  const optional = MISS_CLASSES.filter((name) => name !== "ok" && name !== "avoidable" && name !== "undeclared-change")
  const failOn = list(flags["fail-on"])
  const unknownClass = failOn.find((name) => !MISS_CLASSES.includes(name as MissClass) || name === "ok")
  if (unknownClass !== undefined) return fail(`--fail-on ${unknownClass}: not a class of call; choose from ${optional.join(", ")} (avoidable and undeclared-change always fail)`, 2)
  const allow = list(flags.allow)
  const causes = (Object.keys(CAUSE_GROUP) as Cause[]).filter(isHarnessCause)
  const unknownCause = allow.find((name) => !causes.includes(name as Cause))
  if (unknownCause !== undefined) return fail(`--allow ${unknownCause}: not a cause a harness controls; choose from ${causes.join(", ")}`, 2)
  const loaded = await loadAnalysis(input, flags)
  if (typeof loaded === "string") return fail(loaded, 2)
  for (const warning of loaded.analysis.warnings.slice(0, 10)) console.error(printable(`warning: ${warning}`))
  const check = classifyMisses(loaded.analysis, { failOn: failOn as MissClass[], allow: allow as Cause[] })
  process.stdout.write(flags.json ? renderCheckJson(check, { trace: input }) : renderCheck(check, { title: input === "-" ? "stdin" : path.basename(input) }))
  return check.ok ? 0 : 1
}

/** Reads a trace and analyzes it with the pricing the flags name. Returns a message when it cannot. */
async function loadAnalysis(input: string, flags: Flags) {
  const text = input === "-" ? await streamText(process.stdin) : await readFile(expandHome(input))
  if (text === undefined) return `cannot read ${input}`
  const name = input === "-" ? "stdin" : input
  if (text.trim() === "") return `${name} is empty: no trace records (did the import find any model calls?)`
  const parsed = parseTrace(text)
  if (parsed.records.length === 0 && !looksLikeTrace(text))
    return `${name} is not a prefixlens trace (no line has "v": 1); convert harness logs first with prefixlens import <adapter> <path>`
  for (const error of parsed.errors.slice(0, 20)) console.error(printable(`error: ${error}`))
  if (parsed.errors.length > 20) console.error(`error: ... ${parsed.errors.length - 20} more`)
  if (parsed.records.length === 0) return parsed.errors.length > 0 ? "no valid trace records" : "the trace has no records (the import found no model calls with usage)"
  const pricingPath = typeof flags.pricing === "string" ? flags.pricing : undefined
  const pricing = await loadPricing(pricingPath)
  const tolerance = typeof flags.tolerance === "string" ? Number(flags.tolerance) : undefined
  if (tolerance !== undefined && !(Number.isFinite(tolerance) && tolerance >= 0)) return "--tolerance must be a non-negative number"
  const catalogueProviders = typeof flags["catalogue-provider"] === "string" ? parseProviderMapping(flags["catalogue-provider"]) : undefined
  const catalogueWarnings: string[] = []
  const catalogue =
    flags["no-catalogue"] === true
      ? undefined
      : await loadCatalogue().catch((error: unknown) => {
          catalogueWarnings.push(`not using the models.dev prices: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        })
  const analysis = analyze(parsed.records, {
    pricing,
    ...(catalogue ? { catalogue } : {}),
    ...(catalogueProviders ? { catalogueProviders } : {}),
    ...(tolerance !== undefined ? { toleranceTokens: tolerance } : {}),
  })
  analysis.warnings.unshift(...parsed.warnings, ...catalogueWarnings)
  return { analysis, pricing, pricingSource: pricingPath || process.env.PREFIXLENS_PRICING || "bundled pricing.json", catalogue }
}

async function runRecord(flags: Flags): Promise<number> {
  const provider = flags.provider
  if (provider !== "anthropic" && provider !== "openai") return fail("record needs --provider anthropic or --provider openai")
  const port = flags.port === undefined ? 8787 : Number(flags.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fail("--port must be a port number")
  if (typeof flags.upstream === "string" && !URL.canParse(flags.upstream)) return fail(`--upstream must be a URL, got ${flags.upstream}`)
  const { startProxy } = await import("./proxy.ts")
  const trace = typeof flags.out === "string" ? flags.out : "prefixlens.trace.jsonl"
  const quiet = flags.quiet === true
  let count = 0
  const proxy = await startProxy({
    provider,
    port,
    trace,
    ...(typeof flags.host === "string" ? { hostname: flags.host } : {}),
    ...(typeof flags.upstream === "string" ? { upstream: flags.upstream } : {}),
    ...(typeof flags["allow-origin"] === "string" ? { allowedOrigins: flags["allow-origin"].split(",").map((origin) => origin.trim()).filter(Boolean) } : {}),
    ...(flags["keep-identifiers"] === true ? { keepIdentifiers: true } : {}),
    ...(flags["keep-binary"] === true ? { keepBinary: true } : {}),
    onRecord: (record) => {
      count++
      if (quiet) return
      const prompt = promptTokens(record.usage)
      const rate = prompt === 0 ? 0 : (record.usage.cache_read_tokens / prompt) * 100
      // The lane and the model id come from the request, which any local process can send.
      console.error(
        printable(
          `#${count} ${record.lane} ${record.model}: prompt ${prompt.toLocaleString("en-US")}, cache read ${record.usage.cache_read_tokens.toLocaleString("en-US")} (${rate.toFixed(0)}%), output ${record.usage.output_tokens.toLocaleString("en-US")}`,
        ),
      )
    },
    onSkip: (reason) => {
      if (!quiet) console.error(printable(reason))
    },
  })
  const variable = provider === "anthropic" ? `ANTHROPIC_BASE_URL=${proxy.url}` : `OPENAI_BASE_URL=${proxy.url}/v1`
  console.error(`prefixlens recording ${provider} calls to ${trace}, forwarding to ${proxy.upstream}`)
  console.error(`point your harness at it: ${variable}`)
  console.error("auth headers are forwarded and never written; press Ctrl-C to stop")
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve())
  })
  await proxy.stop()
  console.error(`\nstopped; ${count} ${count === 1 ? "call" : "calls"} recorded in ${trace}. Next: prefixlens report ${trace}`)
  return 0
}

// A harness log passed to `report` by mistake would otherwise print an error for every field of every line.
function looksLikeTrace(text: string): boolean {
  return text.split("\n").some((line) => /^\s*\{.*"v"\s*:\s*1\b/.test(line))
}

async function readFile(file: string): Promise<string | undefined> {
  return readText(file, "utf8").catch(() => undefined)
}

function expandHome(file: string): string {
  return file === "~" || file.startsWith("~/") ? path.join(os.homedir(), file.slice(1)) : file
}

function fail(message: string, code = 1): number {
  console.error(`prefixlens: ${message}`)
  return code
}

// Run as a program (bun src/cli.ts, node dist/cli.js, or the installed bin, a symlink), not imported.
// Bun and Node 24.2+ set import.meta.main; older Node compares the script path.
const invoked = (import.meta as { main?: boolean }).main ?? (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))

if (invoked) {
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

