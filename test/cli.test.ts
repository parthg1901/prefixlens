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
    // A models.dev overlay in the real user cache must not change these reports.
    env: { ...process.env, NO_COLOR: "1", PREFIXLENS_PRICING: "", XDG_CACHE_HOME: path.join(temp, "cache") },
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
    expect(imported.stderr).toContain("wrote 5 records (3 full-request, 2 usage-only; 3 matched the digest the harness logged of the request it built)")
    const report = run(["report", trace])
    expect(report.code).toBe(0)
    expect(report.stdout).toContain("turn 5: miss, tool list changed (+1 tool: 2 → 3), ~$0.02")
    expect(report.stdout).toContain("1 miss cost $0.02 at list prices; 1 from tool-list changes")
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
    expect(run(["report", trace, "--pricing", pricing]).stdout).toContain("$0.00 at API list prices")
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

  test("errors a user hits by mistake are named, with exit code 1", async () => {
    const expectFailure = (args: string[], message: string, stdin?: string) => {
      const result = run(args, stdin)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(message)
    }
    const empty = path.join(temp, "empty.jsonl")
    await Bun.write(empty, "")
    const log = path.join(fixtures, "claude-code-session.jsonl")
    const badPricing = path.join(temp, "bad-pricing.json")
    await Bun.write(badPricing, "{ not json")
    expectFailure(["import", "claude-code", path.join(temp, "missing.jsonl")], "missing.jsonl: no such file or directory")
    expectFailure(["import", "claude-code", empty], `no model calls with usage found in ${empty}; nothing written`)
    expectFailure(["report", empty], "is empty: no trace records")
    expectFailure(["report", "-"], "stdin is empty", "")
    expectFailure(["report", log], 'is not a prefixlens trace (no line has "v": 1); convert harness logs first with prefixlens import')
    expectFailure(["report", log, "--jsno"], "unknown option --jsno")
    expectFailure(["report", log, "--pricing"], "--pricing needs a value")
    const trace = path.join(temp, "errors.trace.jsonl")
    run(["import", "claude-code", log, "-o", trace])
    expectFailure(["report", trace, "--pricing", badPricing], `pricing table ${badPricing} is not valid JSON`)
  })

  test("a truncated last line is reported and the rest of the trace still reads", async () => {
    const trace = path.join(temp, "truncated.trace.jsonl")
    run(["import", "claude-code", path.join(fixtures, "claude-code-session.jsonl"), "-o", trace])
    const lines = (await Bun.file(trace).text()).trim().split("\n")
    await Bun.write(trace, [...lines.slice(0, -1), lines.at(-1)!.slice(0, 40)].join("\n"))
    const result = run(["report", trace])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`line ${lines.length}: not valid JSON`)
    expect(result.stdout).toContain(`${lines.length - 1} model calls`)
  })

  test("a session with one call is a cold start and nothing else", async () => {
    const trace = path.join(temp, "one.trace.jsonl")
    run(["import", "claude-code", path.join(fixtures, "claude-code-session.jsonl"), "--no-subagents", "-o", trace])
    await Bun.write(trace, (await Bun.file(trace).text()).split("\n")[0] + "\n")
    const result = run(["report", trace])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("1 model calls")
    expect(result.stdout).toContain("No cache misses after the first call in each lane.")
  })

  test("a model missing from the pricing table is reported without a cost", async () => {
    const pricing = path.join(temp, "no-models.json")
    await Bun.write(pricing, JSON.stringify({ version: 1, models: [] }))
    const trace = path.join(temp, "unpriced.trace.jsonl")
    run(["import", "claude-code", path.join(fixtures, "claude-code-session.jsonl"), "-o", trace])
    const result = run(["report", trace, "--pricing", pricing])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("No price for claude-opus-5-5: add it to the pricing table to get costs.")
  })
})

describe("cli record", () => {
  test("records through the proxy until stopped, then the trace reports", async () => {
    const { startFakeUpstream } = await import("./fake-upstream.ts")
    const upstream = startFakeUpstream()
    const trace = path.join(temp, "recorded.trace.jsonl")
    const child = Bun.spawn(["bun", path.join(root, "src/cli.ts"), "record", "--provider", "openai", "--port", "0", "--upstream", upstream.url, "-o", trace], {
      cwd: temp,
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    })
    const reader = child.stderr.getReader()
    let stderr = ""
    while (!stderr.includes("OPENAI_BASE_URL=")) stderr += new TextDecoder().decode((await reader.read()).value)
    const base = stderr.match(/OPENAI_BASE_URL=(\S+)/)![1]!
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi." }] }]
    for (const extra of [[], [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello." }] }]]) {
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { authorization: "Bearer " + "sk-synthetic-cli-secret", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test-1", stream: true, instructions: "Synthetic.", input: [...input, ...extra] }),
      })
      await response.text()
    }
    await Bun.sleep(50)
    child.kill("SIGINT")
    await child.exited
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      stderr += new TextDecoder().decode(chunk.value)
    }
    upstream.stop()
    expect(child.exitCode).toBe(0)
    expect(stderr).toContain("#1 main gpt-test-1: prompt 3,200, cache read 3,072 (96%), output 40")
    expect(stderr).toContain("stopped; 2 calls recorded")
    const text = await Bun.file(trace).text()
    expect(text).not.toContain("sk-synthetic-cli-secret")
    const report = run(["report", trace])
    expect(report.code).toBe(0)
    expect(report.stdout).toContain("2 model calls")
  })

  test("record needs a provider", () => {
    expect(run(["record"]).stderr).toContain("record needs --provider anthropic or --provider openai")
  })
})
