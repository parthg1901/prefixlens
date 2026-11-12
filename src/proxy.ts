// The recording proxy: forwards every request to the real API unchanged and
// appends each model call to a trace. Point a harness at it with
// ANTHROPIC_BASE_URL or OPENAI_BASE_URL.

import { copyResponse, observeBody } from "./record/fetch.ts"
import { LANE_HEADER, Recorder, SESSION_HEADER } from "./record/recorder.ts"
import { readableByOthers, type Billing, type TraceRecord } from "./trace.ts"

export const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
} as const

export interface ProxyOptions {
  provider: keyof typeof UPSTREAMS
  /** Default 8787. 0 picks a free port. */
  port?: number
  hostname?: string
  /** Where requests go; default the provider's public API. A path here is prefixed to each request path. */
  upstream?: string
  /** Trace file to append to. */
  trace: string
  onRecord?: (record: TraceRecord) => void
  onSkip?: (reason: string) => void
  /** Keep identifying request fields (`metadata`, `user`, `safety_identifier`, `client_metadata`) in `params`. Default false. */
  keepIdentifiers?: boolean
  /** Keep base64 images, documents, audio and files in the trace instead of their SHA-256 and size. Default false. */
  keepBinary?: boolean
  /**
   * Browser origins allowed to call the proxy, e.g. `["http://localhost:3000"]`, or `["*"]` for any.
   * Default none: a request with an `Origin` header (sent by browsers, never by harness CLIs) is refused.
   */
  allowedOrigins?: string[]
  /** Called with each start-up warning (a non-loopback listen address, a plain-HTTP upstream). Default: printed to stderr. */
  onWarning?: (warning: string) => void
}

// Hop-by-hop headers, and ours. Everything else, credentials included, goes upstream untouched (and is never written).
const DROPPED_REQUEST_HEADERS = ["host", "connection", "keep-alive", "content-length", "transfer-encoding", LANE_HEADER, SESSION_HEADER]

export function startProxy(options: ProxyOptions) {
  const upstream = new URL(options.upstream ?? UPSTREAMS[options.provider])
  const base = upstream.origin + upstream.pathname.replace(/\/+$/, "")
  const hostname = options.hostname ?? "127.0.0.1"
  const warn = options.onWarning ?? ((warning: string) => console.error(`prefixlens: warning: ${warning}`))
  for (const warning of startupWarnings(hostname, upstream, options.trace)) warn(warning)
  const recorder = new Recorder({
    trace: options.trace,
    name: "proxy",
    ...(options.onRecord ? { onRecord: options.onRecord } : {}),
    ...(options.onSkip ? { onSkip: options.onSkip } : {}),
    ...(options.keepIdentifiers ? { keepIdentifiers: true } : {}),
    ...(options.keepBinary ? { keepBinary: true } : {}),
    ...(upstreamBilling(upstream) ? { billing: upstreamBilling(upstream) } : {}),
  })
  const server = Bun.serve({
    port: options.port ?? 8787,
    hostname,
    // Model responses can be silent for minutes while the model thinks.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const refused = refusal(request.headers, hostname, options.allowedOrigins ?? [])
      if (refused) {
        options.onSkip?.(`refused a request to ${url.pathname} (403): ${refused}`)
        return Response.json({ error: { type: "forbidden", message: `prefixlens proxy: ${refused}` } }, { status: 403 })
      }
      // The proxy relays HTTP only. Codex opens Responses over a WebSocket first and falls back to
      // HTTP at once on 426; forwarded upstream, the handshake fails only after several retries.
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        options.onSkip?.(`refused a WebSocket handshake to ${url.pathname} (426): the proxy records HTTP only`)
        return new Response("prefixlens proxy: WebSockets are not relayed; use HTTP", { status: 426 })
      }
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
      const headers = new Headers(request.headers)
      for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name)
      const pending = request.method === "POST" && body ? recorder.begin({ path: url.pathname, body, headers: request.headers }) : undefined
      const response = await fetch(base + url.pathname + url.search, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        redirect: "manual",
        signal: request.signal,
      }).catch((error: unknown) => error as Error)
      if (response instanceof Error) {
        pending?.abandon(`upstream request failed (${response.message})`)
        if (request.signal.aborted) return new Response(null, { status: 499 })
        return Response.json({ error: { type: "proxy_error", message: `prefixlens could not reach ${upstream.origin}: ${response.message}` } }, { status: 502 })
      }
      if (!pending || !response.ok || !response.body) {
        if (pending) pending.abandon(`upstream answered ${response.status}`)
        return copyResponse(response, response.body ?? new ReadableStream({ start: (controller) => controller.close() }))
      }
      return copyResponse(response, observeBody(response.body, pending.finish, { toSocket: true }))
    },
  })
  return {
    server,
    url: `http://${server.hostname}:${server.port}`,
    upstream: base,
    trace: options.trace,
    stop: () => server.stop(true),
  }
}

/**
 * How calls through this upstream are billed, when the upstream alone says so.
 * ChatGPT's backend serves only signed-in plans. Any other endpoint may be
 * reached with an API key or a plan's token, so it is left unsaid.
 */
export function upstreamBilling(upstream: URL): Billing | undefined {
  return /(^|\.)chatgpt\.com$/.test(upstream.hostname) ? "subscription" : undefined
}

/**
 * Why a request must not be relayed, if it must not. A web page in the user's
 * browser can send requests to a loopback port. With its own Host (DNS
 * rebinding) it is refused by the Host check; from a page on any origin, by the
 * Origin check. Harness clients send neither an Origin nor a foreign Host.
 */
function refusal(headers: Headers, configured: string, allowedOrigins: string[]): string | undefined {
  const host = headers.get("host")
  const name = host === null ? undefined : hostOf(host)
  if (name === undefined || !(isLoopback(name) || name === bare(configured).toLowerCase()))
    return `the Host header ${host === null ? "is missing" : `"${host}" is not a loopback address or the address the proxy listens on`}`
  const origin = headers.get("origin")
  if (origin !== null && !allowedOrigins.includes("*") && !allowedOrigins.includes(origin))
    return `requests from web pages are refused (Origin ${origin}); start the proxy with --allow-origin ${origin} to allow this one`
  return undefined
}

function startupWarnings(hostname: string, upstream: URL, trace: string): string[] {
  return [
    ...(isLoopback(bare(hostname).toLowerCase())
      ? []
      : [
          `listening on ${hostname}, which is not a loopback address: anyone who can reach the port can send requests through the proxy into your trace, and API keys and prompts reach it over plain HTTP`,
        ]),
    ...(upstream.protocol === "http:" && !isLoopback(bare(upstream.hostname).toLowerCase())
      ? [`the upstream ${upstream.origin} is plain HTTP to another machine: your API keys and prompts are sent to it unencrypted`]
      : []),
    ...(readableByOthers(trace) ? [`${trace} already exists and other users can read it; prefixlens keeps its permissions (chmod 600 to make it private)`] : []),
  ]
}

function hostOf(host: string): string | undefined {
  try {
    return bare(new URL(`http://${host}`).hostname).toLowerCase()
  } catch {
    return undefined
  }
}

// IPv6 addresses appear in brackets in URLs and Host headers.
function bare(name: string): string {
  return name.replace(/^\[(.*)\]$/, "$1")
}

function isLoopback(name: string): boolean {
  return name === "localhost" || name.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(name) || name === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(name)
}
