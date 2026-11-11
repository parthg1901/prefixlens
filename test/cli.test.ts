import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const fixtures = path.join(import.meta.dir, "fixtures")
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-cli-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

function run(args: string[], stdin?: string) {
  const result = Bun.spawnSync(["bun", path.join(root, "src/cli.ts"), ...args], {
    cwd: temp,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    env: { ...process.env, NO_COLOR: "1", PREFIXLENS_PRICING: "" },
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe("cli", () => {
  test("help and version", () => {
    expect(run(["--help"]).stdout).toContain("prefixlens import <adapter> <path>")
    expect(run(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(run([]).code).toBe(1)
  })

  test("adapters lists each adapter with its fidelity", () => {
    const out = run(["adapters"]).stdout
    expect(out).toContain("claude-code  (full-request)")
    expect(out).toContain("opencode  (usage-only)")
  })

  test("import writes a trace and report reads it", () => {
    const trace = path.join(temp, "session.trace.jsonl")
    const imported = run(["import", "claude-code", path.join(fixtures, "claude-code-session.jsonl"), "-o", trace])
    expect(imported.code).toBe(0)
    expect(imported.stderr).toContain("wrote 5 records (3 full-request, 2 usage-only; 3 checked against the request digest the harness logged)")
    const report = run(["report", trace])
    expect(report.code).toBe(0)
    expect(report.stdout).toContain("turn 5: miss, tool list changed (+1 tool: 2 → 3), ~$0.02")
    expect(report.stdout).toContain("1 miss cost $0.02; 1 from tool-list changes")
    expect(report.stdout).toContain("+ web_fetch")
    expect(report.stdout).not.toContain("\x1b[")
  })

  test("--json output is complete JSON even when piped", () => {
    const trace = path.join(temp, "json.trace.jsonl")
    run(["import", "claude-code", path.join(fixtures, "claude-code-session.jsonl"), "-o", trace])
    const parsed = JSON.parse(run(["report", trace, "--json"]).stdout)
    expect(parsed.report).toBe("prefixlens")
    expect(parsed.summary.misses).toBe(1)
    expect(parsed.turns).toHaveLength(5)
  })

  test("--html writes one self-contained file", async () => {
    const trace = path.join(temp, "html.trace.jsonl")
    run(["import", "claude-code", path.join(fixtures, "claude-code-session.jsonl"), "-o", trace])
    const result = run(["report", trace, "--html"])
    expect(result.stderr).toContain("html.trace.html")
    const html = await Bun.file(path.join(temp, "html.trace.html")).text()
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("tool list changed (+1 tool: 2 → 3)")
    expect(html).not.toMatch(/(src|href)="https?:/)
    run(["report", trace, "--html", path.join(temp, "named.html")])
    expect(await Bun.file(path.join(temp, "named.html")).exists()).toBe(true)
  })

  test("report reads stdin and an opencode import pipes straight in", () => {
    const trace = run(["import", "opencode", path.join(fixtures, "opencode-storage"), "--session", "ses_main"]).stdout
    const report = run(["report", "-"], trace)
    expect(report.code).toBe(0)
    expect(report.stdout).toContain("usage-only")
    expect(report.stdout).toContain("model changed (claude-sonnet-4-5 → gpt-4.1)")
  })

  test("--list shows opencode sessions", () => {
    expect(run(["import", "opencode", path.join(fixtures, "opencode-storage"), "--list"]).stdout).toContain("ses_child")
  })

  test("a custom pricing table is used", async () => {
    const pricing = path.join(temp, "pricing.json")
    await Bun.write(pricing, JSON.stringify({ models: [{ match: "*", input: 0, output: 0, cache_read: 0, cache_write: 0 }] }))
    const trace = path.join(temp, "free.trace.jsonl")
    run(["import", "claude-code", path.join(fixtures, "claude-code-session.jsonl"), "-o", trace])
    expect(run(["report", trace, "--pricing", pricing]).stdout).toContain("$0.00 total")
  })

  test("clear errors", async () => {
    expect(run(["import", "nope", "x"]).stderr).toContain('unknown adapter "nope"')
    expect(run(["report", path.join(temp, "missing.jsonl")]).stderr).toContain("cannot read")
    const bad = path.join(temp, "bad.jsonl")
    await Bun.write(bad, '{"v":1}\n')
    const result = run(["report", bad])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("line 1: ts must be an RFC 3339 timestamp string")
    expect(result.stderr).toContain("no valid trace records")
  })
})
