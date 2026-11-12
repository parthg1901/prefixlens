// What the CLI writes is private to the owner: `import -o` traces and `report --html` reports.

import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { main } from "../src/cli.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-cli-private-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
const session = path.join(import.meta.dir, "fixtures", "claude-code-session.jsonl")
const mode = (file: string) => statSync(file).mode & 0o777

describe("files the CLI writes", () => {
  test("import -o creates the trace and its new directories owner-only", async () => {
    const out = path.join(temp, "new", "dir", "session.trace.jsonl")
    expect(await main(["import", "claude-code", session, "--no-subagents", "-o", out])).toBe(0)
    expect(mode(out)).toBe(0o600)
    expect(mode(path.join(temp, "new", "dir"))).toBe(0o700)
    expect(mode(path.join(temp, "new"))).toBe(0o700)
  })

  test("import -o keeps the mode of a file that already existed, and warns when others can read it", async () => {
    const out = path.join(temp, "existing.trace.jsonl")
    writeFileSync(out, "")
    chmodSync(out, 0o644)
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void errors.push(args.join(" "))
    try {
      expect(await main(["import", "claude-code", session, "--no-subagents", "-o", out])).toBe(0)
    } finally {
      console.error = original
    }
    expect(mode(out)).toBe(0o644)
    expect(errors.some((line) => line.includes("already existed and other users can read it"))).toBe(true)
  })

  test("report --html writes the report owner-only", async () => {
    const trace = path.join(temp, "new", "dir", "session.trace.jsonl")
    const html = path.join(temp, "reports", "session.html")
    const original = console.error
    console.error = () => {}
    try {
      expect(await main(["report", trace, "--html", html])).toBe(0)
    } finally {
      console.error = original
    }
    expect(mode(html)).toBe(0o600)
  })
})
