// The built CLI under Node: every command on the synthetic fixtures.

import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixtures, run, tempDir } from "./helpers.mjs"

const SPEC_TRACE = path.join(fixtures, "..", "..", "SPEC.md")

test("--help and --version", () => {
  const help = run(["--help"])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /prefixlens import <adapter> <path>/)
  const version = run(["--version"])
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(path.join(fixtures, "..", "..", "package.json"), "utf8")).version)
})

test("import with each adapter, then report in the terminal, as JSON and as HTML", (t) => {
  const dir = tempDir(t, "cli")
  const cases = [
    ["claude-code", path.join(fixtures, "claude-code-session.jsonl"), 5],
    ["claude-code", path.join(fixtures, "claude-code-legacy.jsonl"), 5],
    ["codex", path.join(fixtures, "codex"), 8],
    ["otel", path.join(fixtures, "otel", "export.json"), 3],
    ["opencode", path.join(fixtures, "opencode-storage"), 7],
  ]
  for (const [adapter, input, count] of cases) {
    const out = path.join(dir, `${adapter}-${path.basename(input)}.trace.jsonl`)
    const imported = run(["import", adapter, input, "-o", out])
    assert.equal(imported.code, 0, imported.stderr)
    assert.match(imported.stderr, new RegExp(`wrote ${count} records`))
    assert.equal(statSync(out).mode & 0o777, 0o600)
    const terminal = run(["report", out])
    assert.equal(terminal.code, 0, terminal.stderr)
    assert.match(terminal.stdout, new RegExp(`${count} model calls`))
    const json = JSON.parse(run(["report", out, "--json"]).stdout)
    assert.equal(json.summary.turns, count)
  }
  const trace = path.join(dir, "claude-code-claude-code-session.jsonl.trace.jsonl")
  const html = run(["report", trace, "--html", path.join(dir, "report.html")])
  assert.equal(html.code, 0, html.stderr)
  assert.match(readFileSync(path.join(dir, "report.html"), "utf8"), /^<!doctype html>/i)
  // import writes to stdout without -o, and report reads stdin.
  const piped = run(["import", "codex", path.join(fixtures, "codex")])
  assert.match(run(["report", "-"], { input: piped.stdout }).stdout, /8 model calls/)
})

test("the SPEC example reports the tool-list miss", () => {
  const example = readFileSync(SPEC_TRACE, "utf8").match(/## 9\. Example[\s\S]*?```jsonl\n([\s\S]*?)```/)[1]
  const report = run(["report", "-"], { input: example })
  assert.equal(report.code, 0, report.stderr)
  assert.match(report.stdout, /turn 3: miss, tool list changed \(\+1 tool: 1 → 2\)/)
})

const sqlite = await import("node:sqlite").catch(() => undefined)

test("without node:sqlite (Node before 22.13), importing an opencode database says what it needs", { skip: sqlite ? "this Node has node:sqlite" : false }, (t) => {
  const dir = tempDir(t, "nosqlite")
  writeFileSync(path.join(dir, "opencode.db"), "")
  const result = run(["import", "opencode", path.join(dir, "opencode.db")])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /needs SQLite, built into Node 22\.13\.0 and later/)
})

test("an opencode SQLite database (node:sqlite) gives the same records as the JSON storage", { skip: sqlite ? false : "node:sqlite needs Node 22.13 or later" }, (t) => {
  const dir = tempDir(t, "sqlite")
  const { DatabaseSync } = sqlite
  const file = path.join(dir, "opencode.db")
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  const storage = path.join(fixtures, "opencode-storage", "storage")
  const read = (...parts) => JSON.parse(readFileSync(path.join(storage, ...parts), "utf8"))
  for (const name of readdirSync(path.join(storage, "session", "proj_demo"))) {
    const session = read("session", "proj_demo", name)
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(session.id, session.projectID, session.parentID ?? null, session.title, session.time.created, session.time.updated)
  }
  for (const sessionID of readdirSync(path.join(storage, "message")))
    for (const name of readdirSync(path.join(storage, "message", sessionID))) {
      const message = read("message", sessionID, name)
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(message.id, sessionID, message.time.created, message.time.created, JSON.stringify(message))
      const partDir = path.join(storage, "part", message.id)
      for (const partName of statSync(partDir, { throwIfNoEntry: false }) ? readdirSync(partDir) : []) {
        const part = read("part", message.id, partName)
        db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(part.id, message.id, sessionID, message.time.created, message.time.created, JSON.stringify(part))
      }
    }
  db.close()
  const listed = run(["import", "opencode", file, "--list"])
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /ses_main/)
  const fromDb = run(["import", "opencode", file, "--session", "ses_main"])
  const fromJson = run(["import", "opencode", path.join(fixtures, "opencode-storage"), "--session", "ses_main"])
  assert.equal(fromDb.code, 0, fromDb.stderr)
  assert.equal(fromDb.stdout, fromJson.stdout)
})

test("pricing show, and pricing update from a saved catalogue", (t) => {
  const cache = tempDir(t, "cache")
  const shown = run(["pricing", "show", "claude-opus-5-5", "--no-catalogue"], { cache })
  assert.equal(shown.code, 0, shown.stderr)
  assert.match(shown.stdout, /source {7}the bundled pricing\.json/)
  const updated = run(["pricing", "update", "--from", path.join(fixtures, "catalogue", "api.json")], { cache })
  assert.equal(updated.code, 0, updated.stderr)
  assert.match(run(["pricing", "show", "claude-opus-5-5"], { cache }).stdout, /models\.dev/)
  assert.equal(statSync(path.join(cache, "prefixlens", "models.dev.json")).mode & 0o777, 0o600)
  assert.equal(statSync(path.join(cache, "prefixlens")).mode & 0o777, 0o700)
})

test("check: exit 1 with the offending call, 0 when allowed, 2 when it cannot check", () => {
  const trace = path.join(fixtures, "agent-session.jsonl")
  const failed = run(["check", trace])
  assert.equal(failed.code, 1)
  assert.match(failed.stdout, /^prefixlens check: agent-session\.jsonl\nFAIL: 1 of 5 calls\n\n  turn 4: avoidable miss \[tools_changed\], tool list changed/)
  assert.match(failed.stdout, /5 calls: 1 avoidable miss, 1 cold start, 3 ok\n$/)
  const json = run(["check", trace, "--json"])
  assert.equal(json.code, 1)
  assert.deepEqual(JSON.parse(json.stdout).calls.map((call) => call.class), ["cold-start", "ok", "ok", "avoidable", "ok"])
  assert.equal(run(["check", trace, "--allow", "tools_changed"]).code, 0)
  assert.equal(run(["check", trace, "--allow", "tools_changed", "--fail-on", "cold-start"]).code, 1)
  assert.equal(run(["check", path.join(fixtures, "no-such.jsonl")]).code, 2)
  assert.equal(run(["check", trace, "--fail-on", "nonsense"]).code, 2)
})
