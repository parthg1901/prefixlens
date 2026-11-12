// A trace holds whatever the agent read, so nothing prefixlens prints from one may carry a control
// character to the terminal or a CI log: the terminal report, the diff, an assertion's message and
// the proxy's line per call.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { analyze } from "../src/analyze.ts"
import { assertPrefixStable, PrefixBreakError } from "../src/assert.ts"
import { parsePricing } from "../src/pricing.ts"
import { escapeJsonControls, printable, printableDeep } from "../src/printable.ts"
import { renderJson } from "../src/report/json.ts"
import { renderTerminal } from "../src/report/terminal.ts"
import { renderDiff } from "../src/textdiff.ts"
import { serializeTrace } from "../src/trace.ts"
import { startFakeUpstream } from "./fake-upstream.ts"
import { body, fullRecord, resetClock, TEST_PRICING, TOOLS, usage, user } from "./helpers.ts"

const ESC = "\x1b"
const BEL = "\x07"
// Every C0 and C1 control character and DEL, except newline and tab.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

// What a hostile page or tool server could put in a request: a window title, a colour change and a
// line rewrite in the system prompt, a bell in a tool name, an escape in the model id.
const MODEL = `claude-test${ESC}[31m-1`
const TOOL = { ...TOOLS[0]!, name: `fetch${BEL}_page` }
const SYSTEM_BEFORE = `You are a synthetic agent.${ESC}]0;synthetic title${BEL} Today is Monday.\r\x9b2K`
const SYSTEM_AFTER = `You are a synthetic agent.${ESC}]0;synthetic title${BEL} Today is Tuesday.\r\x9b2K`
const before = body([user("Synthetic prompt one.")], { model: MODEL, tools: [TOOLS[1]!, TOOL], system: SYSTEM_BEFORE })
const after = body([user("Synthetic prompt one.")], { model: MODEL, tools: [TOOLS[1]!, TOOL], system: SYSTEM_AFTER })
const fewerTools = body([user("Synthetic prompt one.")], { model: MODEL, tools: [TOOLS[1]!], system: SYSTEM_AFTER })

function trace() {
  resetClock()
  return [fullRecord(before, usage(3, 0, 2000)), fullRecord(after, usage(3, 0, 2000)), fullRecord(fewerTools, usage(3, 0, 1800))]
}

describe("printable", () => {
  test("writes control characters visibly and leaves newline, tab and other text alone", () => {
    expect(printable(`a${ESC}[31mb${BEL}\r\x00\x7f\x9bc`)).toBe("a\\x1b[31mb\\x07\\x0d\\x00\\x7f\\x9bc")
    expect(printable("line one\n\tline two · é → 漢")).toBe("line one\n\tline two · é → 漢")
    expect(printable(printable(`${ESC}${BEL}`))).toBe("\\x1b\\x07")
  })

  test("printableDeep reaches every string of a value, keys included", () => {
    const value: Record<string, unknown> = { [`k${ESC}`]: [`v${BEL}`, 1, null, { deep: `${ESC}` }], n: 2, flag: true }
    expect(printableDeep(value)).toEqual({ "k\\x1b": ["v\\x07", 1, null, { deep: "\\x1b" }], n: 2, flag: true })
  })
})

describe("control characters from a trace", () => {
  test("the terminal report prints none, plain or coloured", () => {
    const analysis = analyze(trace(), { pricing: parsePricing(TEST_PRICING) })
    expect(analysis.turns.map((turn) => turn.status)).toEqual(["cold", "miss", "miss"])
    const plain = renderTerminal(analysis, { all: true, title: `run${ESC}[2J.trace.jsonl`, pricingNote: `prices from table${BEL}.json` })
    expect(plain).not.toMatch(CONTROL)
    // The content is still there to read: the model id, the tool that went away, the changed prompt, the unpriced model.
    expect(plain).toContain("claude-test\\x1b[31m-1")
    expect(plain).toContain("- fetch\\x07_page")
    expect(plain).toContain("\\x1b]0;synthetic title\\x07 Today is Tuesday.\\x0d\\x9b2K")
    expect(plain).toContain("No price for claude-test\\x1b[31m-1")
    expect(plain).toContain("prefixlens report: run\\x1b[2J.trace.jsonl")
    expect(plain).toContain("prices from table\\x07.json")

    // Coloured: the only escape sequences are the report's own colour codes.
    const coloured = renderTerminal(analysis, { all: true, color: true })
    expect(coloured).toContain(`${ESC}[1m`)
    expect(coloured.replace(/\x1b\[(1|2|22|31|32|33|34|36|39)m/g, "")).not.toMatch(CONTROL)
  })

  test("the JSON report prints none and parses to the content as it was", () => {
    const records = trace()
    records[2] = { ...records[2]!, lane: "lane\x9b2K\x7f" }
    const analysis = analyze(records, { pricing: parsePricing(TEST_PRICING) })
    renderTerminal(analysis)
    const json = renderJson(analysis)
    expect(json.replaceAll("\n", "")).not.toMatch(CONTROL)
    const parsed = JSON.parse(json) as typeof analysis
    expect(parsed.turns[0]!.model).toBe(MODEL)
    expect(parsed.turns[2]!.lane).toBe("lane\x9b2K\x7f")
    expect(parsed.turns).toEqual(JSON.parse(JSON.stringify(analysis.turns)))
    expect(escapeJsonControls(JSON.stringify("a\x9bb"))).toBe('"a\\u009bb"')
  })

  test("a diff's lines carry none", () => {
    const diff = renderDiff({ text: SYSTEM_BEFORE, name: TOOL.name }, { text: SYSTEM_AFTER, name: `fetch${BEL}_pages` })
    expect(diff).not.toMatch(CONTROL)
    expect(diff).toContain("+ name: fetch\\x07_pages")
    expect(diff).toContain("Today is Tuesday.\\x0d\\x9b2K")
  })

  test("an assertion's message carries none", () => {
    const failures = [
      () => assertPrefixStable(before, after),
      () => assertPrefixStable(after, fewerTools),
      () => assertPrefixStable(before, { ...before, model: `claude-test${ESC}[32m-2` }),
    ].map((run) => {
      try {
        run()
      } catch (error) {
        return error
      }
      return undefined
    })
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(PrefixBreakError)
      expect((failure as PrefixBreakError).message).not.toMatch(CONTROL)
    }
    expect((failures[1] as PrefixBreakError).message).toContain("fetch\\x07_page")
    expect(assertPrefixStable(before, after, { allowBreak: `revert${ESC}[0m` }).message).not.toMatch(CONTROL)
  })
})

describe("control characters at the command line", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-printable-"))
  afterAll(() => rmSync(temp, { recursive: true, force: true }))
  const cli = path.join(import.meta.dir, "..", "src", "cli.ts")
  const env = { ...process.env, NO_COLOR: "1", PREFIXLENS_PRICING: "", XDG_CACHE_HOME: path.join(temp, "cache") }

  test("prefixlens report prints none", async () => {
    const file = path.join(temp, "hostile.trace.jsonl")
    await Bun.write(file, serializeTrace(trace()))
    const result = Bun.spawnSync(["bun", cli, "report", file, "--all"], { cwd: temp, env })
    expect(result.exitCode).toBe(0)
    const stdout = result.stdout.toString()
    expect(stdout).not.toMatch(CONTROL)
    expect(stdout).toContain("- fetch\\x07_page")
    expect(result.stderr.toString()).not.toMatch(CONTROL)
  })

  test("the proxy's line per call prints none", async () => {
    const upstream = startFakeUpstream()
    const child = Bun.spawn(["bun", cli, "record", "--provider", "anthropic", "--port", "0", "--upstream", upstream.url, "-o", path.join(temp, "recorded.trace.jsonl")], { cwd: temp, stderr: "pipe", env })
    const reader = child.stderr.getReader()
    let stderr = ""
    while (!stderr.includes("ANTHROPIC_BASE_URL=")) stderr += new TextDecoder().decode((await reader.read()).value)
    const base = stderr.match(/ANTHROPIC_BASE_URL=(\S+)/)![1]!
    const response = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...before, stream: true }) })
    await response.text()
    await Bun.sleep(50)
    child.kill("SIGINT")
    await child.exited
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stderr += new TextDecoder().decode(chunk.value)
    }
    upstream.stop()
    expect(stderr).toContain("#1 main claude-test\\x1b[31m-1: prompt")
    expect(stderr).not.toMatch(CONTROL)
  })
})
