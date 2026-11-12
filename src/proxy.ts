// The recording proxy: forwards every request to the real API unchanged and
// appends each model call to a trace. Point a harness at it with
// ANTHROPIC_BASE_URL or OPENAI_BASE_URL.

import { copyResponse, observeBody } from "./record/fetch.ts"
import { LANE_HEADER, Recorder, SESSION_HEADER } from "./record/recorder.ts"
import type { TraceRecord } from "./trace.ts"

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
}

// Hop-by-hop headers, and ours. Everything else, credentials included, goes upstream untouched (and is never written).
const DROPPED_REQUEST_HEADERS = ["host", "connection", "keep-alive", "content-length", "transfer-encoding", LANE_HEADER, SESSION_HEADER]

export function startProxy(options: ProxyOptions) {
  const upstream = new URL(options.upstream ?? UPSTREAMS[options.provider])
  const base = upstream.origin + upstream.pathname.replace(/\/+$/, "")
  const recorder = new Recorder({
    trace: options.trace,
    name: "proxy",
    ...(options.onRecord ? { onRecord: options.onRecord } : {}),
    ...(options.onSkip ? { onSkip: options.onSkip } : {}),
  })
  const server = Bun.serve({
    port: options.port ?? 8787,
    hostname: options.hostname ?? "127.0.0.1",
    // Model responses can be silent for minutes while the model thinks.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
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
      return copyResponse(response, observeBody(response.body, pending.finish))
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
