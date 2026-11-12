// The proxy refuses what a web page in the user's browser could send it, and
// says so at start-up when it is exposed beyond the machine.

import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { startProxy } from "../src/proxy.ts"
import { startFakeUpstream } from "./fake-upstream.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-guard-"))
const upstream = startFakeUpstream()
afterAll(() => {
  upstream.stop()
  rmSync(temp, { recursive: true, force: true })
})

const body = JSON.stringify({ model: "claude-test-1", max_tokens: 10, messages: [{ role: "user", content: "Synthetic." }] })

// A raw HTTP request, so the Host header is exactly what a client (or a rebinding page) sends.
async function send(port: number, headers: Record<string, string>, version = "1.1"): Promise<number> {
  const lines = [`POST /v1/messages HTTP/${version}`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "content-type: application/json", `content-length: ${Buffer.byteLength(body)}`, "connection: close", "", body]
  let text = ""
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => void socket.write(lines.join("\r\n")),
        data: (_socket, chunk) => void (text += chunk.toString()),
        close: () => resolve(),
        error: (_socket, error) => reject(error),
      },
    }).catch(reject)
  })
  return Number(text.split(" ")[1])
}

const skipped: string[] = []
const proxy = await startProxy({ provider: "anthropic", port: 0, upstream: upstream.url, trace: path.join(temp, "guard.trace.jsonl"), onSkip: (reason) => skipped.push(reason) })
const port = proxy.port

describe("the proxy's request guard", () => {
  afterAll(() => proxy.stop())

  test("relays what harness clients send: no Origin, a loopback Host", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "127.0.0.1"]) expect(await send(port, { host })).toBe(200)
    expect(skipped.filter((reason) => reason.includes("403"))).toEqual([])
  })

  test("refuses a Host that is not loopback or the listen address (DNS rebinding), and a missing Host", async () => {
    const before = upstream.seen.length
    expect(await send(port, { host: `attacker.example:${port}` })).toBe(403)
    expect(await send(port, { host: `192.168.1.20:${port}` })).toBe(403)
    // Bun itself answers 400 to an HTTP/1.1 request without Host; either way it is not relayed.
    expect([400, 403]).toContain(await send(port, {}))
    expect(upstream.seen.length).toBe(before)
    expect(skipped.some((reason) => reason.includes('Host header "attacker.example'))).toBe(true)
  })

  test("answers 403 to an HTTP/1.0 request without Host, which reaches the proxy with a URL that has no origin", async () => {
    const before = upstream.seen.length
    expect(await send(port, {}, "1.0")).toBe(403)
    expect(upstream.seen.length).toBe(before)
    expect(skipped.at(-1)).toContain("the Host header is missing")
    // The proxy is still serving afterwards.
    expect(await send(port, { host: `127.0.0.1:${port}` })).toBe(200)
  })

  test("refuses a request with an Origin header, from any page, preflight included", async () => {
    const before = upstream.seen.length
    expect(await send(port, { host: `127.0.0.1:${port}`, origin: "https://attacker.example" })).toBe(403)
    expect(await send(port, { host: `127.0.0.1:${port}`, origin: "http://localhost:3000" })).toBe(403)
    const preflight = await fetch(`${proxy.url}/v1/messages`, { method: "OPTIONS", headers: { origin: "https://attacker.example", "access-control-request-method": "POST" } })
    expect(preflight.status).toBe(403)
    expect(upstream.seen.length).toBe(before)
    expect(skipped.at(-1)).toContain("--allow-origin https://attacker.example")
    // "null" is what every sandboxed frame and local file sends: refused, and allowing it is not suggested.
    expect(await send(port, { host: `127.0.0.1:${port}`, origin: "null" })).toBe(403)
    expect(skipped.at(-1)).toContain("Origin null")
    expect(skipped.at(-1)).not.toContain("--allow-origin")
    expect(upstream.seen.length).toBe(before)
  })

  test("relays an Origin that was explicitly allowed, and only that one", async () => {
    const allowed = await startProxy({ provider: "anthropic", port: 0, upstream: upstream.url, trace: path.join(temp, "allowed.trace.jsonl"), allowedOrigins: ["http://localhost:3000"] })
    const allowedPort = allowed.port
    expect(await send(allowedPort, { host: `127.0.0.1:${allowedPort}`, origin: "http://localhost:3000" })).toBe(200)
    expect(await send(allowedPort, { host: `127.0.0.1:${allowedPort}`, origin: "https://attacker.example" })).toBe(403)
    await allowed.stop()
  })
})

describe("start-up warnings", () => {
  const warningsFor = (options: { hostname?: string; upstream?: string; trace?: string }) => {
    const warnings: string[] = []
    const proxy = startProxy({ provider: "anthropic", port: 0, upstream: upstream.url, trace: path.join(temp, "warn.trace.jsonl"), ...options, onWarning: (warning) => warnings.push(warning) })
    void proxy.then((running) => running.stop())
    return warnings
  }

  test("none on the defaults", () => {
    expect(warningsFor({})).toEqual([])
    expect(warningsFor({ hostname: "localhost" })).toEqual([])
  })

  test("a non-loopback listen address", () => {
    const warnings = warningsFor({ hostname: "0.0.0.0" })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("0.0.0.0, which is not a loopback address")
  })

  test("a plain-HTTP upstream on another machine, but not on this one", () => {
    expect(warningsFor({ upstream: "http://gateway.example:8080" })[0]).toContain("http://gateway.example:8080 is plain HTTP")
    expect(warningsFor({ upstream: "http://127.0.0.1:9" })).toEqual([])
    expect(warningsFor({ upstream: "https://gateway.example" })).toEqual([])
  })

  test("an existing trace other users can read", () => {
    const trace = path.join(temp, "open.trace.jsonl")
    writeFileSync(trace, "")
    chmodSync(trace, 0o644)
    expect(warningsFor({ trace })[0]).toContain("other users can read it")
  })
})
