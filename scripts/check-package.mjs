// Checks the package as a consumer gets it: packs it with `npm pack` (a local tarball; nothing is
// published), lists what it ships, installs it into fresh temporary projects (with npm, run under Node,
// and with Bun when it is on PATH), and in each runs the CLI, `prefixlens/test` in the runtime's own
// test runner, the library type-checked against the shipped declarations, and the proxy streaming
// from a local fake upstream. Everything happens in a temporary directory that is removed at the end.
//
//   node scripts/check-package.mjs            npm + Node, and Bun if installed
//   node scripts/check-package.mjs --no-bun   npm + Node only

import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixtures = path.join(root, "test", "fixtures")
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-package-"))
const failures = []
const npmEnv = { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", npm_config_cache: path.join(temp, "npm-cache") }

try {
  const tarball = pack()
  checkNode(tarball)
  if (!process.argv.includes("--no-bun") && spawnSync("bun", ["--version"]).status === 0) checkBun(tarball)
  else console.log("bun: not on PATH or --no-bun; skipped")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`)
  process.exit(1)
}
console.log("\npackage check passed")

function pack() {
  const out = path.join(temp, "pack")
  mkdirSync(out)
  const [result] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", out], { cwd: root, env: npmEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }))
  const files = result.files.map((file) => file.path).sort()
  console.log(`tarball ${result.filename}: ${(result.size / 1024).toFixed(1)} kB packed, ${(result.unpackedSize / 1024).toFixed(1)} kB unpacked, ${files.length} files`)
  const allowed = /^(dist\/.+\.(js|d\.ts)|pricing\.json|SPEC\.md|README\.md|LICENSE|CHANGELOG\.md|SECURITY\.md|package\.json)$/
  check("only dist, pricing.json, the docs and package.json ship", files.every((file) => allowed.test(file)), files.filter((file) => !allowed.test(file)).join(", "))
  check("the CLI, both entry points and their declarations ship", ["dist/cli.js", "dist/index.js", "dist/index.d.ts", "dist/assert.js", "dist/assert.d.ts"].every((file) => files.includes(file)))
  const tarball = path.join(out, result.filename)
  const unpacked = path.join(temp, "unpacked")
  mkdirSync(unpacked)
  execFileSync("tar", ["-xzf", tarball, "-C", unpacked])
  const text = files.map((file) => readFileSync(path.join(unpacked, "package", file), "utf8")).join("\n")
  check("no absolute local paths or source maps in the tarball", !/\/home\/[a-z]|\/Users\/[A-Za-z]|sourceMappingURL/.test(text))
  check("the CLI has a Node shebang and is executable", readFileSync(path.join(unpacked, "package", "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node\n") && (statSync(path.join(unpacked, "package", "dist", "cli.js")).mode & 0o111) !== 0)
  return tarball
}

function checkNode(tarball) {
  const project = consumer("node-consumer")
  execFileSync("npm", ["install", "--no-package-lock", "--offline", tarball], { cwd: project, env: npmEnv, stdio: ["ignore", "ignore", "inherit"] })
  const bin = path.join(project, "node_modules", ".bin", "prefixlens")
  runCli("node", (args, input) => spawnSync(bin, args, { cwd: project, encoding: "utf8", input, env: { ...process.env, NO_COLOR: "1", XDG_CACHE_HOME: path.join(project, "cache") } }), project)
  writeFileSync(path.join(project, "prefix.test.mjs"), assertionTest("node:test"))
  const tested = spawnSync(process.execPath, ["--test", "prefix.test.mjs"], { cwd: project, encoding: "utf8" })
  check("node: `node --test` with prefixlens/test", tested.status === 0, tested.stdout + tested.stderr)
  typecheck(project)
  proxy("node", process.execPath, project)
}

function checkBun(tarball) {
  const project = consumer("bun-consumer")
  const installed = spawnSync("bun", ["add", tarball], { cwd: project, encoding: "utf8", env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(temp, "bun-cache") } })
  if (!check("bun: bun add <tarball>", installed.status === 0, installed.stderr)) return
  const cli = path.join(project, "node_modules", "prefixlens", "dist", "cli.js")
  runCli("bun", (args, input) => spawnSync("bun", [cli, ...args], { cwd: project, encoding: "utf8", input, env: { ...process.env, NO_COLOR: "1", XDG_CACHE_HOME: path.join(project, "cache") } }), project)
  writeFileSync(path.join(project, "prefix.test.mjs"), assertionTest("bun:test"))
  const tested = spawnSync("bun", ["test", "./prefix.test.mjs"], { cwd: project, encoding: "utf8" })
  check("bun: `bun test` with prefixlens/test", tested.status === 0, tested.stdout + tested.stderr)
  proxy("bun", "bun", project)
}

function consumer(name) {
  const project = path.join(temp, name)
  mkdirSync(project)
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name, private: true, type: "module" }, null, 2))
  return project
}

function runCli(runtime, prefixlens, project) {
  const help = prefixlens(["--help"])
  check(`${runtime}: prefixlens --help`, help.status === 0 && help.stdout.includes("prefixlens import <adapter> <path>"), help.stderr)
  const imports = [
    ["claude-code", path.join(fixtures, "claude-code-session.jsonl"), 5],
    ["codex", path.join(fixtures, "codex"), 8],
    ["otel", path.join(fixtures, "otel", "export.json"), 3],
    ["opencode", path.join(fixtures, "opencode-storage"), 7],
  ]
  for (const [adapter, input, count] of imports) {
    const out = path.join(project, `${adapter}.trace.jsonl`)
    const result = prefixlens(["import", adapter, input, "-o", out])
    check(`${runtime}: import ${adapter}`, result.status === 0 && result.stderr.includes(`wrote ${count} records`), result.stderr)
  }
  const trace = path.join(project, "claude-code.trace.jsonl")
  const terminal = prefixlens(["report", trace])
  check(`${runtime}: report (terminal)`, terminal.status === 0 && terminal.stdout.includes("5 model calls"), terminal.stderr)
  const json = prefixlens(["report", trace, "--json"])
  check(`${runtime}: report --json`, json.status === 0 && JSON.parse(json.stdout).summary.turns === 5, json.stderr)
  const html = prefixlens(["report", trace, "--html", path.join(project, "report.html")])
  check(`${runtime}: report --html`, html.status === 0 && readFileSync(path.join(project, "report.html"), "utf8").includes("<html"), html.stderr)
  const shown = prefixlens(["pricing", "show", "claude-opus-5-5"])
  check(`${runtime}: pricing show`, shown.status === 0 && shown.stdout.includes("bundled pricing.json"), shown.stderr)
}

function assertionTest(runner) {
  return `import { test } from "${runner}"
import assert from "node:assert/strict"
import { assertPrefixStable, PrefixBreakError } from "prefixlens/test"

const first = { model: "claude-test-1", system: "Synthetic.", messages: [{ role: "user", content: "Hi." }] }
test("an extension is stable; a rewritten system prompt is not", () => {
  assertPrefixStable(first, { ...first, messages: [...first.messages, { role: "assistant", content: "Hello." }] })
  assert.throws(() => assertPrefixStable(first, { ...first, system: "Synthetic, at 10:02." }), PrefixBreakError)
})
`
}

function typecheck(project) {
  writeFileSync(
    path.join(project, "consumer.ts"),
    `import Default, { createLens, wrap, startProxy, type TraceRecord } from "prefixlens"
import { assertPrefixStable, explainPrefixDiff } from "prefixlens/test"

const client = wrap({ fetch: globalThis.fetch }, { trace: false, onRecord: (record: TraceRecord) => console.log(record.usage.cache_read_tokens) })
const lens = createLens({ trace: false })
const fetchFn: typeof fetch = lens.fetch()
const explanation: { stable: boolean; message: string } = explainPrefixDiff({ messages: [] }, { messages: [] })
assertPrefixStable({ messages: [] }, { messages: [] })
const proxy: Promise<{ url: string; stop(): Promise<void> }> = startProxy({ provider: "anthropic", port: 0, trace: "x.trace.jsonl" })
// @ts-expect-error provider must be anthropic or openai
void startProxy({ provider: "gemini", trace: "x" })
void [client, fetchFn, explanation, proxy, Default.wrap]
`,
  )
  writeFileSync(
    path.join(project, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", strict: true, noEmit: true, skipLibCheck: false, types: ["node"], typeRoots: [path.join(root, "node_modules", "@types")] }, files: ["consumer.ts"] }, null, 2),
  )
  const result = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", project], { cwd: project, encoding: "utf8" })
  check("node: TypeScript type-checks a consumer against the shipped declarations (skipLibCheck off)", result.status === 0, result.stdout + result.stderr)
}

// The installed package's proxy, run by `runtime`, against a fake upstream that streams in that process.
function proxy(runtime, executable, project) {
  const script = path.join(project, "proxy-check.mjs")
  writeFileSync(
    script,
    `import http from "node:http"
import { readFileSync } from "node:fs"
import { startProxy } from "prefixlens"
const events = readFileSync(${JSON.stringify(path.join(fixtures, "streams", "anthropic.sse"))}, "utf8").split(/(?<=\\n\\n)/)
let release
const held = new Promise((resolve) => (release = resolve))
const upstream = http.createServer(async (request, response) => {
  for await (const _ of request);
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const [index, event] of events.entries()) {
    response.write(event)
    if (index === 0) await held
  }
  response.end()
})
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const records = []
const proxy = await startProxy({ provider: "anthropic", port: 0, upstream: "http://127.0.0.1:" + upstream.address().port, trace: "proxy.trace.jsonl", onRecord: (record) => records.push(record) })
const response = await fetch(proxy.url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-synthetic-check" }, body: JSON.stringify({ model: "claude-test-1", stream: true, system: "Synthetic.", messages: [{ role: "user", content: "Hi." }] }) })
const reader = response.body.getReader()
let text = new TextDecoder().decode((await reader.read()).value)
const streamed = text.includes("message_start")
release()
for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value) }
for (let turn = 0; turn < 100 && records.length === 0; turn++) await new Promise((resolve) => setTimeout(resolve, 10))
await proxy.stop()
upstream.close()
const ok = streamed && text === events.join("") && records.length === 1 && !readFileSync("proxy.trace.jsonl", "utf8").includes("sk-synthetic-check")
console.log(JSON.stringify({ streamed, complete: text === events.join(""), records: records.length }))
process.exit(ok ? 0 : 1)
`,
  )
  const result = spawnSync(executable, [script], { cwd: project, encoding: "utf8", timeout: 30_000 })
  check(`${runtime}: the installed proxy streams from a local upstream and records the call`, result.status === 0, result.stdout + result.stderr)
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
  if (!ok) failures.push(`${name}${detail ? `: ${String(detail).trim().slice(0, 2000)}` : ""}`)
  return ok
}
