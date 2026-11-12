// Turns one HTTP exchange with a model API (request body plus response body,
// streamed or not) into a trace record. Shared by the recording proxy, the
// recording fetch behind `wrap(client)`, and `lens.observe`.

import { canonicalizeRequest, isRecord, type Provider } from "../canonical.ts"
import type { TraceRecord } from "../trace.ts"
import { withoutIdentifiers } from "../params.ts"
import { normalizeUsage } from "../usage.ts"
import pkg from "../../package.json" with { type: "json" }

export type Api = "anthropic-messages" | "openai-chat" | "openai-responses"

export const PROVIDER_OF: Record<Api, Provider> = {
  "anthropic-messages": "anthropic",
  "openai-chat": "openai",
  "openai-responses": "openai",
}

/** The API a request path calls, when it is a model call prefixlens records. */
export function apiFromPath(pathname: string): Api | undefined {
  const path = pathname.replace(/\/+$/, "")
  if (/\/messages$/.test(path)) return "anthropic-messages"
  if (/\/chat\/completions$/.test(path)) return "openai-chat"
  if (/\/responses$/.test(path)) return "openai-responses"
  return undefined
}

/**
 * The API a request body was written for, from its shape: `input` or
 * `instructions` mean Responses; a top-level `system`, Anthropic-style tools
 * or content parts mean Anthropic Messages; anything else with `messages` is
 * Chat Completions.
 */
export function apiFromBody(body: Record<string, unknown>): Api {
  if (body.input !== undefined || body.instructions !== undefined) return "openai-responses"
  const anthropic =
    body.system !== undefined ||
    body.thinking !== undefined ||
    asArray(body.tools).some((tool) => isRecord(tool) && ("input_schema" in tool || "cache_control" in tool)) ||
    asArray(body.messages).some(
      (message) =>
        isRecord(message) &&
        asArray(message.content).some((part) => isRecord(part) && (["tool_use", "tool_result", "thinking", "redacted_thinking"].includes(String(part.type)) || "cache_control" in part)),
    )
  return anthropic ? "anthropic-messages" : "openai-chat"
}

export interface ResponseSummary {
  /** Raw provider usage object, merged across stream events. */
  usage?: Record<string, unknown>
  id?: string
  model?: string
  /** True when the response reached its terminal event (or was a complete JSON body). */
  complete: boolean
}

/**
 * Reads usage, id and model from a response body: a JSON object, a list of
 * already-parsed stream events, or server-sent-events text. A stream cut off
 * early still yields what it reported so far (Anthropic reports input and
 * cache usage in its first event).
 */
export function readResponse(api: Api, response: unknown): ResponseSummary {
  const events = typeof response === "string" ? sseEvents(response) : Array.isArray(response) ? response : undefined
  if (!events) return readJson(api, response)
  if (typeof response === "string" && events.length === 0) {
    const json = parseJson(response.trim())
    if (json !== undefined) return readJson(api, json)
  }
  const summary: ResponseSummary = { complete: false }
  for (const event of events) {
    if (!isRecord(event)) continue
    if (api === "anthropic-messages") {
      if (event.type === "message_start" && isRecord(event.message)) {
        summary.id = stringOr(event.message.id, summary.id)
        summary.model = stringOr(event.message.model, summary.model)
        if (isRecord(event.message.usage)) summary.usage = { ...event.message.usage }
      }
      // message_delta usage is cumulative; newer API versions repeat the input fields there too.
      if (event.type === "message_delta" && isRecord(event.usage)) summary.usage = { ...summary.usage, ...withoutNulls(event.usage) }
      if (event.type === "message_stop") summary.complete = true
    }
    if (api === "openai-chat") {
      summary.id = stringOr(event.id, summary.id)
      summary.model = stringOr(event.model, summary.model)
      if (isRecord(event.usage)) summary.usage = event.usage
      if (asArray(event.choices).some((choice) => isRecord(choice) && choice.finish_reason)) summary.complete = true
    }
    if (api === "openai-responses" && isRecord(event.response)) {
      summary.id = stringOr(event.response.id, summary.id)
      summary.model = stringOr(event.response.model, summary.model)
      if (isRecord(event.response.usage)) summary.usage = event.response.usage
      if (["response.completed", "response.incomplete", "response.failed", "response.done"].includes(String(event.type))) summary.complete = true
    }
  }
  return summary
}

function readJson(api: Api, body: unknown): ResponseSummary {
  if (!isRecord(body)) return { complete: false }
  // A Responses stream's final event passed on its own: {type: "response.completed", response: {...}}.
  const target = api === "openai-responses" && isRecord(body.response) ? body.response : body
  return {
    ...(isRecord(target.usage) ? { usage: target.usage } : {}),
    ...(typeof target.id === "string" ? { id: target.id } : {}),
    ...(typeof target.model === "string" ? { model: target.model } : {}),
    complete: isRecord(target.usage),
  }
}

/** Parses server-sent events: `data:` lines joined per event, comments and `[DONE]` skipped. */
export function sseEvents(text: string): unknown[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n\n")
    .flatMap((chunk) => {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
        .join("\n")
      if (data === "" || data === "[DONE]") return []
      const event = parseJson(data)
      return event === undefined ? [] : [event]
    })
}

/** Request headers worth keeping: they route requests to a cache or change what is cached. Nothing else is ever written. */
export const RECORDED_HEADERS = ["session-id", "anthropic-beta", "anthropic-version", "openai-beta"]

/** What `buildRecord` needs to know about one model call. */
export interface RecordInput {
  /** Which API the call went to. `apiFromPath(url.pathname)` or `apiFromBody(body)` tell it. */
  api: Api
  /** The request body exactly as sent, parsed from JSON. */
  body: Record<string, unknown>
  /** The response as `readResponse(api, raw)` summarizes it, from the JSON body, the SSE text or the parsed stream events. */
  response: ResponseSummary
  /** When the request was sent. Cache lifetimes run from the request start. */
  startedAt: Date | number | string
  /** Request headers. Only `RECORDED_HEADERS` are kept; credentials never are. */
  headers?: Headers | Record<string, string>
  session?: string
  /** Default "main". */
  lane?: string
  /** `source.recorder`. The proxy writes "proxy", `wrap` "wrap", `lens.observe` "observe"; default "library". */
  recorder?: string
  /**
   * Keep the request fields that identify a person or installation
   * (`IDENTIFYING_PARAMS`: `metadata`, `user`, `safety_identifier`,
   * `client_metadata`) in `params`. Default false: they are left out.
   */
  keepIdentifiers?: boolean
}

/** @deprecated Use RecordInput. Removed in the next minor. */
export type ExchangeInput = RecordInput

/**
 * Builds the trace record for one model call from its request and response:
 * the same function the recording proxy, `wrap` and `lens.observe` use, so a
 * harness that calls it with the same inputs gets the same record, and
 * `serializeTrace` or `createTraceEncoder` then writes the same line.
 *
 * Returns a string, the reason, when no record can be built: the response
 * reported no usage (an error, a stream cut off before usage, a Chat
 * Completions stream without `stream_options.include_usage`).
 *
 * Stable from 0.3: inputs may gain optional fields, never lose or change one.
 */
export function buildRecord(input: RecordInput): TraceRecord | string {
  const provider = PROVIDER_OF[input.api]
  if (!input.response.usage)
    return input.api === "openai-chat" && input.body.stream === true
      ? "the stream reported no usage (Chat Completions streams include usage only with stream_options.include_usage)"
      : input.response.complete
        ? "the response had no usage"
        : "the response ended before it reported usage"
  const canonical = canonicalizeRequest(provider, input.body)
  const given = input.headers instanceof Headers ? input.headers : new Headers(input.headers)
  const headers = Object.fromEntries(RECORDED_HEADERS.flatMap((name) => (given.get(name) ? [[name, given.get(name)!]] : [])))
  const ttl = input.api === "anthropic-messages" ? anthropicTtl(input.body) : undefined
  return {
    v: 1,
    ...(input.response.id ? { id: input.response.id } : {}),
    ...(input.session ? { session: input.session } : {}),
    lane: input.lane ?? "main",
    ts: new Date(input.startedAt).toISOString(),
    provider,
    model: canonical.model || input.response.model || "",
    params: withoutIdentifiers(canonical.params, input.keepIdentifiers),
    fidelity: "full-request",
    request: { blocks: canonical.blocks },
    usage: normalizeUsage(provider, input.response.usage),
    ...(ttl ? { cache_ttl_seconds: ttl } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    source: { recorder: input.recorder ?? "library", api: input.api, version: pkg.version, ...(input.response.complete ? {} : { complete: false }) },
  }
}

// The TTL that applies to what a request wrote: that of its last cache_control
// breakpoint, in prefix order (tools, system, messages, then the top-level one
// that marks the end of the request).
function anthropicTtl(body: Record<string, unknown>): number | undefined {
  const markers = [
    ...asArray(body.tools),
    ...(Array.isArray(body.system) ? body.system : []),
    ...asArray(body.messages).flatMap((message) => (isRecord(message) ? [message, ...asArray(message.content)] : [])),
    body,
  ].flatMap((part) => (isRecord(part) && isRecord(part.cache_control) ? [part.cache_control] : []))
  const last = markers.at(-1)
  if (!last) return undefined
  return last.ttl === "1h" ? 3600 : 300
}

function withoutNulls(object: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined))
}

function stringOr(value: unknown, fallback: string | undefined) {
  return typeof value === "string" ? value : fallback
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
