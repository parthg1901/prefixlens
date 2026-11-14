// A fetch that records model calls while passing every byte through unchanged.

import { deliveredBody } from "../runtime/server.ts"
import type { Recorder } from "./recorder.ts"

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Wraps `inner` so each model call it makes is recorded. Requests are sent
 * exactly as given; the response body is handed to the caller chunk by chunk
 * as it arrives and copied aside, and the record is written when the body
 * ends or the caller stops reading it.
 */
export function recordingFetch(recorder: Recorder, inner: Fetch, name?: string): Fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
    const body = method === "POST" ? await bodyOf(init?.body, request) : undefined
    const headers = new Headers(init?.headers ?? request?.headers)
    const pending = body === undefined ? undefined : recorder.begin({ path: url.pathname, body, headers, ...(name ? { recorder: name } : {}) })
    if (!pending) return inner(input, init)
    const response = await inner(input, init).catch((error: unknown) => {
      pending.abandon(`request failed (${error instanceof Error ? error.message : String(error)})`)
      throw error
    })
    if (!response.ok || !response.body) {
      pending.abandon(`upstream answered ${response.status}`)
      return response
    }
    return copyResponse(response, observeBody(response.body, pending.finish))
  }
}

/**
 * Passes a body through unbuffered and calls `onEnd` once with its text, whether it ended or was
 * cancelled, only after the reader has every byte: recording never delays or reorders the response.
 *
 * In-process readers (`wrap`, `lens.fetch`) have a chunk as soon as their read resolves; `onEnd`
 * waits for the next turn of the event loop so their own handling of the end runs first.
 * `toSocket` is for a body the proxy's server sends to a client: `onEnd` runs only once every byte,
 * the body's end included, has been handed to the socket (see `deliveredBody`, on Bun and on Node).
 */
export function observeBody(body: ReadableStream<Uint8Array>, onEnd: (text: string) => unknown, options: { toSocket?: boolean } = {}): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    // A failure to record never reaches the caller.
    const failed = (error: unknown) => console.error(`prefixlens: could not record a call: ${error instanceof Error ? error.message : String(error)}`)
    try {
      Promise.resolve(onEnd(Buffer.concat(chunks).toString("utf8"))).catch(failed)
    } catch (error) {
      failed(error)
    }
  }
  if (options.toSocket) return deliveredBody(reader, (chunk) => chunks.push(chunk), end)
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await reader.read().catch((error: unknown) => ({ error }))
        if ("error" in next) {
          setImmediate(end)
          return controller.error(next.error)
        }
        if (next.done) {
          setImmediate(end)
          return controller.close()
        }
        chunks.push(next.value)
        controller.enqueue(next.value)
      },
      cancel(reason) {
        end()
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}

/** The same response with another body. Content-Encoding and Content-Length are dropped: fetch has already decoded the body. */
export function copyResponse(response: Response, body: ReadableStream<Uint8Array>): Response {
  const headers = new Headers(response.headers)
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) headers.delete(name)
  const copy = new Response(body, { status: response.status, statusText: response.statusText, headers })
  if (response.url) Object.defineProperty(copy, "url", { value: response.url })
  return copy
}

/** The body of a request as its caller gave it: text or bytes; undefined for a body of another kind. */
export async function bodyOf(body: RequestInit["body"] | undefined, request: Request | undefined): Promise<string | Uint8Array | undefined> {
  if (typeof body === "string" || body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (body === undefined && request) return new Uint8Array(await request.clone().arrayBuffer())
  return undefined
}

