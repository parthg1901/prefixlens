// `prefixlens check --requests`: request bodies a test in another language captured, checked from the
// command line as assertSessionStable checks them. Every body here is synthetic.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-check-requests-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

function run(args: string[], stdin?: string) {
  const result = Bun.spawnSync(["bun", path.join(root, "src/cli.ts"), "check", ...args], {
    cwd: temp,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    env: { ...process.env, NO_COLOR: "1", PREFIXLENS_PRICING: "", XDG_CACHE_HOME: path.join(temp, "cache") },
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

function write(name: string, text: string) {
  const file = path.join(temp, name)
  writeFileSync(file, text)
  return file
}

const system = "You are a synthetic agent."
const tools = [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }]
const step = (messages: unknown[], extra: Record<string, unknown> = {}) => ({ model: "claude-test-1", max_tokens: 100, system, tools, messages, ...extra })
const m1 = [{ role: "user", content: "One." }]
const m2 = [...m1, { role: "assistant", content: "OK." }, { role: "user", content: "Two." }]
const m3 = [...m2, { role: "assistant", content: "OK." }, { role: "user", content: "Three." }]
const title = { model: "claude-test-1", max_tokens: 20, system: "Write a title.", messages: [{ role: "user", content: "A title for: One." }] }
const steady = [step(m1), title, step(m2), step(m3)]

describe("prefixlens check --requests", () => {
  test("a run that keeps its prefix passes, with one line saying how much was compared", () => {
    const result = run(["--requests", write("steady.json", JSON.stringify(steady))])
    expect(result).toEqual({
      code: 0,
      stdout: "prefixlens check: steady.json\nok: 2 calls compared, each keeps the prefix of the call before it in its lane (4 request bodies, 2 lanes: call 2 starts a conversation of its own and is compared with nothing)\n",
      stderr: "",
    })
  })

  test("a real break exits 1 with prefixlens's message, worded for the command line", () => {
    const at = (time: string) => ({ system: `${system} Now: 2026-01-01T${time}Z` })
    const broken = [step(m1, at("10:00:00")), step(m2, at("10:00:00")), step(m3, at("10:00:01"))]
    const result = run(["--requests", write("broken.json", JSON.stringify(broken))])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("")
    expect(result.stdout).toStartWith(
      "prefixlens check: broken.json\nFAIL: prefix not stable at call 3 (lane main, compared with call 2): system prompt changed: a timestamp value was updated",
    )
    expect(result.stdout).toContain("first changed block: 2 of 5 (system part 1); block 1 still matches")
    expect(result.stdout).toContain("+ text: You are a synthetic agent. Now: 2026-01-01T10:00:01Z")
    expect(result.stdout).toContain("system prompt changed: a timestamp value was updated (2026-01-01T10:00:00Z → 2026-01-01T10:00:01Z)")
    expect(result.stdout).toContain("  fix: keep clocks and ids out of the system prompt")
    expect(result.stdout).toContain("  if this change is intentional, pass --allow-break-at 3=<reason>\n")
    expect(result.stdout).not.toContain("allowBreakAt")
  })

  test("--allow-break-at allows a compaction at the call where it happens, and nowhere else", () => {
    const summary = [{ role: "user", content: "Summary: one and two were answered." }, { role: "assistant", content: "Understood." }]
    const compacted = [step(m1), step(m2), step([...summary, { role: "user", content: "Three." }]), step(m1)]
    const file = write("compacted.json", JSON.stringify(compacted.slice(0, 3)))
    expect(run(["--requests", file]).code).toBe(1)
    const allowed = run(["--requests", file, "--allow-break-at", "3=compaction"])
    expect(allowed.code).toBe(0)
    expect(allowed.stdout).toBe(
      "prefixlens check: compacted.json\nok: 2 calls compared, each keeps the prefix of the call before it in its lane (3 request bodies, 1 lane; break allowed at call 3 (compaction))\n",
    )
    // A rewind at call 4 is not covered by the compaction allowed at call 3.
    const later = run(["--requests", write("compacted-then-rewound.json", JSON.stringify(compacted)), "--allow-break-at", "3=compaction"])
    expect(later.code).toBe(1)
    expect(later.stdout).toContain("FAIL: prefix not stable at call 4 ")
  })

  test("JSON Lines, one body per line as a test appends them, from a file or stdin", () => {
    const lines = steady.map((body) => JSON.stringify(body))
    const file = write("steady.jsonl", `${lines[0]}\r\n\n${lines.slice(1).join("\n")}\n`)
    const result = run(["--requests", file])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("ok: 2 calls compared")
    const piped = run(["--requests", "-"], `${lines.join("\n")}\n`)
    expect(piped.code).toBe(0)
    expect(piped.stdout).toStartWith("prefixlens check: stdin\nok: 2 calls compared")
  })

  test("--ignore-params and --provider carry through", () => {
    const thinking = write("thinking.json", JSON.stringify([step(m1), step(m2, { thinking: { type: "enabled", budget_tokens: 1024 } })]))
    expect(run(["--requests", thinking]).code).toBe(1)
    expect(run(["--requests", thinking, "--ignore-params", "thinking"]).code).toBe(0)
    const gemini = (texts: string[]) => ({ systemInstruction: { parts: [{ text: system }] }, contents: texts.map((text, index) => ({ role: index % 2 === 0 ? "user" : "model", parts: [{ text }] })) })
    const result = run(["--requests", write("gemini.json", JSON.stringify([gemini(["One."]), gemini(["One.", "OK.", "Two."])])), "--provider", "gemini"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("ok: 1 call compared")
  })

  test("a body that continues a conversation the provider keeps does not pass: exit 2, naming the call", () => {
    const continued = { model: "claude-test-1", max_tokens: 100, system, tools, thread: { type: "continue", previous_message_id: "msg_synthetic_1" }, messages: [{ role: "user", content: "Two." }] }
    const result = run(["--requests", write("thread.json", JSON.stringify([step(m1), continued]))])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toStartWith(
      "prefixlens: 1 of the 2 calls was not checked (call 2): it continues a conversation the provider keeps (Anthropic's `thread`), so its request carries only what is new",
    )
    // A break among the calls that were compared is still reported first, as a failure.
    const both = run(["--requests", write("thread-and-break.json", JSON.stringify([step(m1), step(m2, { system: "Rewritten." }), continued]))])
    expect(both.code).toBe(1)
    expect(both.stdout).toContain("FAIL: prefix not stable at call 2 ")
  })

  test("input that is not a list of request bodies is named, with exit code 2", () => {
    const expectError = (args: string[], message: string, stdin?: string) => {
      const result = run(args, stdin)
      expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 2, stdout: "" })
      expect(result.stderr).toContain(message)
    }
    const requests = (name: string, text: string) => ["--requests", write(name, text)]
    expectError(requests("empty.json", "\n"), "empty.json is empty: no request bodies")
    expectError(requests("text.json", "not json at all\n"), "text.json: line 1 is not valid JSON; write a JSON array of request bodies, or one body per line (JSON Lines)")
    expectError(requests("cut.json", '[{"model": "claude-test-1"'), "cut.json is not valid JSON (")
    expectError(requests("object.json", JSON.stringify({ requests: steady }, null, 2)), "object.json: line 1 is not valid JSON (the file holds one JSON object, not a list of request bodies)")
    expectError(requests("string.json", '"hello"'), 'string.json: line 1 is a string, not a request body object')
    expectError(requests("entry.json", JSON.stringify([step(m1), 5])), "entry.json: entry 2 of the array is a number, not a request body object")
    expectError(requests("line.jsonl", `${JSON.stringify(step(m1))}\nnull\n`), "line.jsonl: line 2 is null, not a request body object")
    expectError(requests("nested.jsonl", `${JSON.stringify(step(m1))}\n[1, 2]\n`), "nested.jsonl: line 2 is an array, not a request body object")
    expectError(requests("none.json", "[]"), "none.json is an empty array: no request bodies")
    expectError(requests("one.json", JSON.stringify([step(m1)])), "nothing to compare: 1 request was recorded")
    expectError(["--requests", path.join(temp, "missing.json")], "cannot read")
    expectError(["--requests", "-"], "stdin is empty: no request bodies", "")
    const trace = path.join(root, "test", "fixtures", "agent-session.jsonl")
    expectError(["--requests", trace], "agent-session.jsonl is a prefixlens trace, not a list of request bodies; check it with prefixlens check <trace>, without --requests")
  })

  test("options it cannot use are named, with exit code 2", () => {
    const expectError = (args: string[], message: string) => {
      const result = run(args)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(message)
    }
    const file = write("options.json", JSON.stringify(steady))
    expectError(["--requests"], "--requests needs a value")
    expectError(["--requests", file, "--allow-brake-at", "3=compaction"], "unknown option --allow-brake-at")
    expectError(["--requests", file, "--allow-break-at", "3"], "--allow-break-at 3: write <call>=<reason>, e.g. 7=compaction")
    expectError(["--requests", file, "--allow-break-at", "3=compaction,3=revert"], "--allow-break-at names call 3 twice")
    expectError(["--requests", file, "--allow-break-at", "9=compaction"], "--allow-break-at names call 9, but options.json holds 4 request bodies (numbered from 1)")
    expectError(["--requests", file, "--allow-break-at", "2=compaction"], '--allow-break-at names call 2, but it is the first call of its lane ("lane-2")')
    expectError(["--requests", file, "--provider", "mistral"], "--provider mistral: choose from anthropic, openai, gemini")
    expectError(["--requests", file, "--json"], "--json applies to a trace, not to --requests")
    expectError(["--requests", file, "--allow", "compaction"], "--allow applies to a trace, not to --requests; to allow a break at one call, use --allow-break-at <call>=<reason>")
    expectError([file, "--requests", file], "check takes a trace or --requests <file>, not both")
    const trace = path.join(root, "test", "fixtures", "agent-session.jsonl")
    expectError([trace, "--allow-break-at", "4=compaction"], "--allow-break-at applies to request bodies, with --requests <file>")
  })
})
