// The HTTP server the recording proxy listens with: Bun.serve on Bun, node:http on Node. Everything
// runtime-specific about serving lives here, including the one guarantee the proxy depends on: a
// body made with `deliveredBody` calls its `delivered` callback only once every byte of it, the
// body's end included, has been handed to the socket, on either runtime.

import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/** One request as the proxy sees it, the body already read. */
export interface IncomingCall {
  method: string
  /** Path and query; the origin is not meaningful (use the Host header). */
  url: URL
  headers: Headers
  body: Uint8Array | undefined
  /** Aborted when the client goes away before the response has been sent. */
  signal: AbortSignal
}

export interface ServeOptions {
  port: number
  hostname: string
  handle: (call: IncomingCall) => Promise<Response>
}

export interface Served {
  hostname: string
  port: number
  /** Stops listening and closes open connections. */
  stop(): Promise<void>
}

export interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
}

const bun = (globalThis as { Bun?: typeof Bun }).Bun

/** The encodings the runtime's fetch decodes, so that a decoded body can be passed on without its Content-Encoding. */
export const DECODED_ENCODINGS: readonly string[] = bun
  ? ["gzip", "deflate", "br", "zstd"]
  : ["gzip", "deflate", "br", ...(Number(process.versions.node?.split(".")[0]) >= 24 ? ["zstd"] : [])]

export async function serve(options: ServeOptions): Promise<Served> {
  return bun ? serveBun(bun, options) : serveNode(options)
}

/**
 * A response body that passes each chunk of `source` on as it is read, after `onChunk` has seen it, and calls
 * `delivered` exactly once: when every byte, the body's end included, is on the socket, when the client
 * goes away, or when `source` fails. Only `serve` sends such a body as promised.
 */
export function deliveredBody(source: ChunkReader, onChunk: (chunk: Uint8Array) => void, delivered: () => void): ReadableStream<Uint8Array> {
  return bun ? bunDirectBody(source, onChunk, delivered) : nodeBody(source, onChunk, delivered)
}

// ---------------------------------------------------------------------------------------------
// Bun

function serveBun(runtime: typeof Bun, options: ServeOptions): Served {
  const server = runtime.serve({
    port: options.port,
    hostname: options.hostname,
    // Model responses can be silent for minutes while the model thinks.
    idleTimeout: 0,
    async fetch(request) {
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
      // A request without a Host header (HTTP/1.0) has a path for a URL, so it needs a base, as on Node below.
      return options.handle({ method: request.method, url: new URL(request.url, "http://localhost"), headers: request.headers, body, signal: request.signal })
    },
  })
  return { hostname: options.hostname, port: server.port ?? options.port, stop: async () => void (await server.stop(true)) }
}

// Bun's direct streams: write() buffers, flush() hands the buffer to the socket, and end() flushes and
// ends the body (the terminating chunk); each returns a promise when the socket pushes back. A chunk
// enqueued on an ordinary stream may still be waiting in Bun's buffers when the stream closes, so each
// chunk is written and flushed, the body is ended, and only then is `delivered` called.
interface DirectController {
  write(chunk: Uint8Array): number | Promise<number>
  flush(): number | Promise<number>
  end(): number | Promise<number>
}

function bunDirectBody(source: ChunkReader, onChunk: (chunk: Uint8Array) => void, delivered: () => void): ReadableStream<Uint8Array> {
  const direct = {
    type: "direct",
    async pull(controller: DirectController) {
      try {
        for (;;) {
          const next = await source.read()
          if (next.done || !next.value) break
          onChunk(next.value)
          await controller.write(next.value)
          await controller.flush()
        }
        // The body's end is a byte too: a client reading to the end waits for it.
        await controller.end()
      } finally {
        delivered()
      }
    },
    cancel(reason: unknown) {
      delivered()
      return source.cancel(reason)
    },
  }
  return new ReadableStream<Uint8Array>(direct as unknown as ConstructorParameters<typeof ReadableStream<Uint8Array>>[0])
}

// ---------------------------------------------------------------------------------------------
// Node

// Marks a body made by deliveredBody; the Node writer calls it once the response has finished on the socket.
const DELIVERED = Symbol("prefixlens.delivered")
type MarkedBody = ReadableStream<Uint8Array> & { [DELIVERED]?: () => void }

function nodeBody(source: ChunkReader, onChunk: (chunk: Uint8Array) => void, delivered: () => void): ReadableStream<Uint8Array> {
  const body: MarkedBody = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await source.read().catch((error: unknown) => ({ error }))
        if ("error" in next) return controller.error(next.error)
        if (next.done || !next.value) return controller.close()
        onChunk(next.value)
        controller.enqueue(next.value)
      },
      cancel(reason) {
        delivered()
        return source.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
  body[DELIVERED] = delivered
  return body
}

async function serveNode(options: ServeOptions): Promise<Served> {
  const http = await import("node:http")
  // requestTimeout 0: a request body may take long to arrive; responses are not limited by it.
  const server = http.createServer({ requestTimeout: 0 }, (request, response) => {
    void respond(options, request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject)
      resolve()
    })
  })
  return {
    hostname: options.hostname,
    port: (server.address() as AddressInfo).port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

async function respond(options: ServeOptions, request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController()
  response.once("close", () => {
    if (!response.writableFinished) controller.abort()
  })
  const chunks: Buffer[] = []
  try {
    for await (const chunk of request) chunks.push(chunk as Buffer)
  } catch {
    return response.destroy()
  }
  const headers = new Headers()
  for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!)
  const answer = await options
    .handle({
      method: request.method ?? "GET",
      url: new URL(request.url ?? "/", "http://localhost"),
      headers,
      body: chunks.length === 0 ? undefined : new Uint8Array(Buffer.concat(chunks)),
      signal: controller.signal,
    })
    .catch((error: unknown) => Response.json({ error: { type: "proxy_error", message: `prefixlens: ${error instanceof Error ? error.message : String(error)}` } }, { status: 500 }))
  await send(answer, response)
}

/** Writes a Response to a Node response: each chunk as it is read, then the end; a delivered body's callback runs once the end is on the socket. */
async function send(answer: Response, response: ServerResponse) {
  const body = answer.body as MarkedBody | null
  const delivered = body?.[DELIVERED]
  const closed = new Promise<void>((resolve) => response.once("close", resolve))
  try {
    const headers: string[] = []
    answer.headers.forEach((value, name) => {
      if (name !== "set-cookie") headers.push(name, value)
    })
    for (const cookie of answer.headers.getSetCookie()) headers.push("set-cookie", cookie)
    response.writeHead(answer.status, answer.statusText, headers)
    if (body) {
      const reader = body.getReader()
      for (;;) {
        if (response.destroyed) {
          await reader.cancel()
          break
        }
        const next = await reader.read()
        if (next.done) break
        if (!response.write(next.value)) await Promise.race([new Promise((resolve) => response.once("drain", resolve)), closed])
      }
    }
    // 'finish' (the end callback) fires once the last chunk and the body's end are handed to the operating system.
    if (!response.destroyed) await Promise.race([new Promise<void>((resolve) => response.end(() => resolve())), closed])
  } catch {
    response.destroy()
  } finally {
    delivered?.()
  }
}
