// Shared by the Node suite: it runs the built package (dist/) under Node, never the TypeScript sources.
// Run `npm run build` (or `bun run build`) first; `npm run test:node` does both.

import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
export const dist = path.join(root, "dist")
export const fixtures = path.join(root, "test", "fixtures")
export const cli = path.join(dist, "cli.js")

export function tempDir(t, name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `prefixlens-node-${name}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Runs the built CLI with Node. */
export function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", XDG_CACHE_HOME: options.cache ?? path.join(os.tmpdir(), "prefixlens-node-no-cache") }, cwd: options.cwd, input: options.input })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Blocks this process's event loop, so a test can prove bytes reached another process before work began. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const STREAMS = { "/v1/messages": "anthropic.sse", "/v1/chat/completions": "chat.sse", "/v1/responses": "responses.sse" }

export function streamText(pathname) {
  return readFileSync(path.join(fixtures, "streams", STREAMS[pathname]), "utf8")
}

/**
 * A local stand-in for the APIs on node:http: the hand-written stream fixtures, one event per chunk.
 * `x-test-hold: 1` sends the first event, then waits for `release()`.
 */
export async function startFakeUpstream() {
  const seen = []
  let release = () => {}
  let held = new Promise((resolve) => (release = resolve))
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString("utf8")
    seen.push({ method: request.method, path: request.url, headers: request.headers, body })
    const file = STREAMS[request.url]
    if (!file) return response.writeHead(404, { "content-type": "application/json" }).end('{"error":{"type":"not_found_error"}}')
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "request-id": "req_synthetic" })
    const events = streamText(request.url).split(/(?<=\n\n)/)
    for (const [index, event] of events.entries()) {
      response.write(event)
      if (request.headers["x-test-hold"] === "1" && index === 0) await held
      else await new Promise((resolve) => setTimeout(resolve, 2))
    }
    response.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    release() {
      release()
      held = new Promise((resolve) => (release = resolve))
    },
    stop: () => new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    }),
  }
}

/** Runs `script` (an ES module) in another Node process and waits for it. */
export function runScript(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "inherit"] })
    child.on("exit", (code) => resolve(code))
  })
}
