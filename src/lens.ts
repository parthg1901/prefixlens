// The recording library: `wrap(client)` for the official Anthropic and OpenAI
// SDKs, `lens.fetch()` for any client that takes a fetch function, and
// `lens.observe({ request, response })` for custom clients.

import { isRecord } from "./canonical.ts"
import { apiFromBody, type Api } from "./record/exchange.ts"
import { recordingFetch, type Fetch } from "./record/fetch.ts"
import { Recorder } from "./record/recorder.ts"
import type { TraceRecord } from "./trace.ts"

export interface LensOptions {
  /**
   * Trace file to append to. Default `$PREFIXLENS_TRACE`, else
   * `prefixlens.trace.jsonl` in the working directory. `false` writes no file
   * (use `onRecord`).
   */
  trace?: string | false
  /** Called with each record after it is written. */
  onRecord?: (record: TraceRecord) => void
  /** Called when a call is not recorded (an error response, a stream with no usage), with the reason. Default: ignored. */
  onSkip?: (reason: string) => void
  /** Session id for every record. */
  session?: string
  /** Lane for every record. Default: assigned by shared prefix, so independent conversations get their own lanes. */
  lane?: string
}

export interface Observation {
  /** The request body as sent: Anthropic Messages, OpenAI Chat Completions or OpenAI Responses. */
  request: Record<string, unknown>
  /**
   * The response: the final JSON body; for a stream, the list of parsed
   * events, the raw SSE text, or just its final event (Responses
   * `response.completed`); or any object with the provider's `usage`.
   */
  response: unknown
  /** Which API the body is for, when its shape is ambiguous. */
  api?: Api
  /** When the request was sent (default: now). Cache lifetimes run from the request start. */
  startedAt?: Date | number | string
  /** Request headers; only `session-id`, `anthropic-beta`, `anthropic-version` and `openai-beta` are kept. */
  headers?: Headers | Record<string, string>
  lane?: string
  session?: string
}

export interface Lens {
  /** Records one call made by a custom client. Returns the record, or undefined when the response has no usage. */
  observe(observation: Observation): TraceRecord | undefined
  /** Records every call of an Anthropic or OpenAI SDK client. Returns the same client. */
  wrap<T extends object>(client: T): T
  /** A fetch that records model calls and changes nothing else. Default inner fetch: the global one. */
  fetch(inner?: Fetch): Fetch
  /** The trace file, if any. */
  readonly trace: string | undefined
}

export function createLens(options: LensOptions = {}): Lens {
  const trace: string | false = options.trace === false ? false : (options.trace ?? process.env.PREFIXLENS_TRACE ?? "prefixlens.trace.jsonl")
  const shared = {
    trace,
    ...(options.onRecord ? { onRecord: options.onRecord } : {}),
    ...(options.onSkip ? { onSkip: options.onSkip } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(options.lane ? { lane: options.lane } : {}),
  }
  const recorder = new Recorder({ ...shared, name: "observe" })
  return {
    trace: trace === false ? undefined : trace,
    observe(observation) {
      const pending = recorder.begin({
        body: observation.request,
        api: observation.api ?? apiFromBody(observation.request),
        startedAt: observation.startedAt === undefined ? new Date() : new Date(observation.startedAt),
        ...(observation.headers ? { headers: new Headers(observation.headers) } : {}),
        ...(observation.lane ? { lane: observation.lane } : {}),
        ...(observation.session ? { session: observation.session } : {}),
      })
      if (!pending) throw new TypeError("lens.observe: request must be the request body object")
      return pending.finish(observation.response)
    },
    wrap(client) {
      const target = client as { fetch?: unknown }
      if (!isRecord(client) || typeof target.fetch !== "function")
        throw new TypeError(
          "prefixlens.wrap expects an official Anthropic or OpenAI SDK client (an object with a `fetch` function). For other clients pass lens.fetch() as their fetch, or call lens.observe().",
        )
      if (!(RECORDING in target.fetch)) target.fetch = mark(recordingFetch(recorder, target.fetch as Fetch, "wrap"))
      return client
    },
    fetch(inner = globalThis.fetch) {
      return mark(recordingFetch(recorder, inner, "fetch"))
    },
  }
}

/**
 * Records every call an official Anthropic or OpenAI TypeScript SDK client
 * makes, streaming included, without changing what it sends or returns:
 *
 *   const client = wrap(new Anthropic())
 *
 * The SDKs send every request through the client's `fetch`; wrap replaces it
 * with a recording one that passes each byte through as it arrives.
 */
export function wrap<T extends object>(client: T, options?: LensOptions): T {
  return createLens(options).wrap(client)
}

const RECORDING = Symbol.for("prefixlens.recording")

function mark(fetch: Fetch): Fetch {
  return Object.assign(fetch, { [RECORDING]: true })
}
