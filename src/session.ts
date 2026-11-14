// The test session of "prefixlens/test": a fetch that stands in for the model
// provider, so a test can run a framework or an agent loop with no network,
// keep every request it sends, and assert that each one extends the request
// before it in the same conversation.
//
// No test-runner imports and no globals: it works the same under node:test,
// bun:test, vitest and jest.

import { explainPair, PrefixBreakError, type PrefixExplanation, type PrefixOptions, type RequestLike } from "./assert.ts"
import { canonicalizeRequest, isRecord } from "./canonical.ts"
import { printable } from "./printable.ts"
import { apiFromBody, apiFromPath, PROVIDER_OF, type Api } from "./record/exchange.ts"
import { bodyOf, type Fetch } from "./record/fetch.ts"
import { Lanes } from "./record/lanes.ts"
import { Recorder } from "./record/recorder.ts"
import { laneKey, serializeTrace, writePrivateFile, type TraceRecord } from "./trace.ts"

/** The request format of a call, told from its URL. */
export type RequestFormat = Api

/** One request the session answered. */
export interface RecordedRequest {
  /** Its number among the session's requests, from 1. Failure messages and `allowBreakAt` use it. */
  call: number
  /** `"anthropic-messages"`, `"openai-chat"` or `"openai-responses"`. */
  format: RequestFormat
  /**
   * The conversation it belongs to: `"main"` for the first, `"lane-2"` and so on for calls that do not
   * build on it (a title generator, a summariser). Each request is compared with the one before it in its lane.
   */
  lane: string
  url: string
  /** The request body exactly as sent, parsed from JSON. */
  body: Record<string, unknown>
}

/** A tool call for the model to make. */
export interface ToolCall {
  name: string
  /** The arguments, as an object. Default `{}`. */
  args?: Record<string, unknown>
}

/** What the model answers: a text, or a text and/or tool calls. */
export type Reply = string | { text?: string; toolCalls?: ToolCall[] }

/** Chooses the reply to each request. */
export type ReplyScript = (request: RecordedRequest) => Reply

export interface SessionOptions {
  /** The reply to each request. Default: the text "OK.", so an agent's turn ends after one call. See `callTools` for a tool loop. */
  reply?: ReplyScript
}

/** What `allowBreak` takes: a reason, or `{ after, reason }`. */
export type AllowedBreak = NonNullable<PrefixOptions["allowBreak"]>

export interface StabilityOptions extends PrefixOptions {
  /**
   * Intentional breaks at particular calls: the call number to what `allowBreak` takes, e.g.
   * `{ 7: "compaction" }` when call 7 is the first after a compaction. `allowBreak` itself applies to every call.
   */
  allowBreakAt?: Record<number, AllowedBreak>
}

/** How one call compares with the call before it in its lane. */
export interface CallExplanation extends PrefixExplanation {
  /** The later call's number. */
  call: number
  /** The call it is compared with: the one before it in the same lane. */
  previous: number
  lane: string
}

export interface RequestSession {
  /**
   * A fetch for your model provider or framework. It never touches the network: it records each
   * Anthropic Messages, OpenAI Chat Completions or OpenAI Responses request and answers it in that
   * format, as a stream when the request asks for one.
   */
  readonly fetch: Fetch
  /** Every request answered so far, in order. */
  readonly requests: readonly RecordedRequest[]
  /** Compares each call with the one before it in its lane. Never throws for a change; `ok` says whether it is allowed. */
  explain(options?: StabilityOptions): CallExplanation[]
  /**
   * Throws a `PrefixBreakError` naming the first call that does not keep the prefix of the call before it in
   * its lane. Also throws when there was nothing to compare, or a request could not be answered.
   * Returns the explanations otherwise.
   */
  assertStable(options?: StabilityOptions): CallExplanation[]
  /** Writes the session as a trace file, for `prefixlens report` and `prefixlens check`. Replaces the file. */
  writeTrace(file: string): void
}

/**
 * Starts a test session. Give `session.fetch` to your model provider, run your agent, then call
 * `session.assertStable()`:
 *
 *   const session = recordRequests()
 *   const model = createAnthropic({ apiKey: "test", fetch: session.fetch })("claude-sonnet-5-5")
 */
export function recordRequests(options: SessionOptions = {}): RequestSession {
  const requests: RecordedRequest[] = []
  const records: TraceRecord[] = []
  const problems: string[] = []
  const recorder = new Recorder({ trace: false, name: "test", joinOnSharedStart: true })
  const script = options.reply ?? (() => "OK.")
  let ids = 0
  const id = (prefix: string) => `${prefix}_test_${String(++ids).padStart(4, "0")}`
  const refuse = (problem: string) => {
    problems.push(problem)
    // Shaped as both providers' SDKs read an error; 404 is not retried.
    return Response.json({ type: "error", error: { type: "not_found_error", message: problem, param: null, code: null } }, { status: 404 })
  }

  const fetch: Fetch = async (input, init) => {
    const given = input instanceof Request ? input : undefined
    const url = given ? given.url : String(input)
    const method = (init?.method ?? given?.method ?? "GET").toUpperCase()
    const format = URL.canParse(url) ? apiFromPath(new URL(url).pathname) : undefined
    const body = method === "POST" && format ? parseBody(await bodyOf(init?.body, given)) : undefined
    const call = body && recorder.open({ path: new URL(url).pathname, body, headers: new Headers(init?.headers ?? given?.headers) })
    if (!format || !body || !call)
      return refuse(
        `prefixlens test session: ${method} ${url} is not a request it can answer${format && !body ? " (the body is not a JSON object)" : ""}. session.fetch answers POST requests to .../messages (Anthropic Messages), .../chat/completions (OpenAI Chat Completions) and .../responses (OpenAI Responses). Use one of those providers for the model, and give any other endpoint (embeddings, a count_tokens call) its own fetch.`,
      )
    const request: RecordedRequest = { call: requests.length + 1, format, lane: call.lane, url, body }
    requests.push(request)
    const reply = readReply(script, request)
    if (typeof reply === "string") return refuse(reply)
    const answer = ANSWERS[format](body, reply, id)
    const record = call.finish(answer.json)
    if (record) records.push(record)
    if (body.stream !== true) return Response.json(answer.json)
    return new Response(answer.events().join(""), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
  }

  const explain = (given: StabilityOptions = {}) =>
    explainCalls(
      // The lane of a call includes its session, when the harness names one in a header.
      records.map((record, index) => ({ call: index + 1, lane: laneKey(record), name: requests[index]!.lane, request: record })),
      given,
    )
  return {
    fetch,
    requests,
    explain,
    assertStable(given = {}) {
      if (problems.length > 0) throw new Error(problems.length === 1 ? problems[0] : `${problems[0]}\n(${problems.length - 1} more: ${problems.slice(1).join("; ")})`)
      if (requests.length === 0)
        throw new Error("prefixlens test session: no request was recorded, so there is nothing to check. Give session.fetch to the model provider your agent uses, e.g. createAnthropic({ fetch: session.fetch }).")
      return assertCalls(explain(given), requests.length)
    },
    writeTrace(file) {
      writePrivateFile(file, serializeTrace(records))
    },
  }
}

/**
 * A reply script for a tool loop: after each user message the model calls these tools, once, and
 * when their results come back it answers with `answer`. A request that offers none of the tools
 * (a title generator, a summariser) gets the answer straight away.
 *
 *   recordRequests({ reply: callTools([{ name: "get_weather", args: { city: "Lisbon" } }]) })
 */
export function callTools(calls: ToolCall[], answer = "Done."): ReplyScript {
  return (request) => {
    const offered = new Set(asArray(request.body.tools).flatMap((tool) => (isRecord(tool) ? [tool.name, isRecord(tool.function) ? tool.function.name : undefined] : [])))
    const toolCalls = endsWithUserMessage(request) ? calls.filter((call) => offered.has(call.name)) : []
    return toolCalls.length > 0 ? { toolCalls } : answer
  }
}

/**
 * `session.assertStable()` for request bodies you already have, in the order they were sent: puts
 * them in lanes the way a session does, and throws a `PrefixBreakError` for the first one that does
 * not keep the prefix of the body before it in its lane. Call numbers are positions in `bodies`, from 1.
 */
export function assertSessionStable(bodies: readonly Record<string, unknown>[], options: StabilityOptions = {}): CallExplanation[] {
  const lanes = new Lanes({ joinOnSharedStart: true })
  const calls = bodies.map((body, index) => {
    if (!isRecord(body)) throw new TypeError(`assertSessionStable: bodies[${index}] is not a request body object`)
    const canonical = canonicalizeRequest(options.provider ?? PROVIDER_OF[apiFromBody(body)], body)
    const lane = lanes.assign(canonical.blocks, { began: index + 1, ...(typeof body.prompt_cache_key === "string" ? { cacheKey: body.prompt_cache_key } : {}) }).name
    return { call: index + 1, lane, name: lane, request: body }
  })
  if (calls.length === 0) throw new Error("assertSessionStable: no request bodies were given, so there is nothing to check")
  return assertCalls(explainCalls(calls, options), calls.length)
}

interface Call {
  call: number
  /** What tells lanes apart. */
  lane: string
  /** The lane as shown. */
  name: string
  request: RequestLike
}

function explainCalls(calls: Call[], options: StabilityOptions): CallExplanation[] {
  const { allowBreakAt, ...shared } = options
  const latest = new Map<string, Call>()
  const pairs = calls.flatMap((next) => {
    const previous = latest.get(next.lane)
    latest.set(next.lane, next)
    return previous ? [{ previous, next }] : []
  })
  for (const key of Object.keys(allowBreakAt ?? {})) {
    const number = Number(key)
    if (!Number.isInteger(number) || number < 1 || number > calls.length)
      throw new TypeError(`prefixlens/test: allowBreakAt names call ${key}, but there ${calls.length === 1 ? "is 1 call" : `are ${calls.length} calls`} (numbered from 1)`)
    if (!pairs.some((pair) => pair.next.call === number))
      throw new TypeError(`prefixlens/test: allowBreakAt names call ${key}, but it is the first call of its lane ("${calls[number - 1]!.name}"): there is no earlier request for it to break`)
  }
  return pairs.map(({ previous, next }) => {
    const allowBreak = allowBreakAt?.[next.call] ?? shared.allowBreak
    const explanation = explainPair(previous.request, next.request, { ...shared, ...(allowBreak === undefined ? {} : { allowBreak }) }, {
      heading: `prefix not stable at call ${next.call} (lane ${next.name}, compared with call ${previous.call})`,
      allow: `pass { allowBreakAt: { ${next.call}: { reason: "..." } } }`,
    })
    return { call: next.call, previous: previous.call, lane: next.name, ...explanation }
  })
}

function assertCalls(explanations: CallExplanation[], calls: number): CallExplanation[] {
  if (explanations.length === 0)
    throw new Error(
      `prefixlens/test: nothing to compare: ${calls === 1 ? "1 request was recorded" : `each of the ${calls} requests is the first of its lane`}. A conversation needs at least two model calls (a second user message, or a tool call and its result) before its prefix can be checked.`,
    )
  const [first, ...others] = explanations.filter((explanation) => !explanation.ok)
  if (!first) return explanations
  const listed = others.slice(0, 5).map((other) => `call ${other.call} (${other.change?.summary})`)
  const more =
    others.length === 0 ? "" : `\n\n  ${others.length === 1 ? "1 more call changes" : `${others.length} more calls change`} the prefix: ${printable(listed.join(", "))}${others.length > listed.length ? ", …" : ""}`
  throw new PrefixBreakError({ ...first, message: first.message + more })
}

function parseBody(raw: string | Uint8Array | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  try {
    const value: unknown = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

interface NormalReply {
  text?: string
  toolCalls: { name: string; args: Record<string, unknown> }[]
}

/** The script's reply in one shape, or a string saying why it cannot be used. */
function readReply(script: ReplyScript, request: RecordedRequest): NormalReply | string {
  const where = `prefixlens test session: the reply script's answer to call ${request.call}`
  let reply: Reply
  try {
    reply = script(request)
  } catch (error) {
    return `prefixlens test session: the reply script threw on call ${request.call}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (typeof reply === "string") return { text: reply, toolCalls: [] }
  if (!isRecord(reply)) return `${where} is ${reply === null ? "null" : typeof reply}; return a string, or an object with text and/or toolCalls`
  const calls = reply.toolCalls ?? []
  if (!Array.isArray(calls) || calls.some((call) => !isRecord(call) || typeof call.name !== "string" || (call.args !== undefined && !isRecord(call.args))))
    return `${where} has toolCalls that are not [{ name, args }] with a string name and an object of arguments`
  if (typeof reply.text !== "string" && calls.length === 0) return `${where} has neither text nor toolCalls; return a string, or an object with text and/or toolCalls`
  return { ...(typeof reply.text === "string" ? { text: reply.text } : {}), toolCalls: calls.map((call) => ({ name: call.name, args: call.args ?? {} })) }
}

// True when the request ends with what the user said, not with a tool's result.
function endsWithUserMessage(request: RecordedRequest): boolean {
  if (request.format === "openai-responses" && typeof request.body.input === "string") return true
  const last = asArray(request.format === "openai-responses" ? request.body.input : request.body.messages).at(-1)
  if (!isRecord(last) || last.role !== "user") return false
  // Anthropic sends tool results inside a user message.
  return !asArray(last.content).some((part) => isRecord(part) && part.type === "tool_result")
}

// --- The replies, in each format's wire shape -------------------------------

interface Answer {
  /** The complete response: what a call without `stream` gets, and what the record's usage is read from. */
  json: Record<string, unknown>
  /** The same response as server-sent events. */
  events(): string[]
}

type Ids = (prefix: string) => string

// A fixed time, so replies are the same on every run: 2026-01-01T10:00:00Z.
const CREATED = 1_767_261_600

/** A rough token count: four characters of JSON to a token. */
function tokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
}

function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`
}

const ANSWERS: Record<Api, (body: Record<string, unknown>, reply: NormalReply, id: Ids) => Answer> = {
  "anthropic-messages": (body, reply, id) => {
    const content = [
      ...(reply.text === undefined ? [] : [{ type: "text", text: reply.text }]),
      ...reply.toolCalls.map((call) => ({ type: "tool_use", id: id("toolu"), name: call.name, input: call.args })),
    ]
    const stop_reason = reply.toolCalls.length > 0 ? "tool_use" : "end_turn"
    const usage = { input_tokens: tokens(body), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: tokens(content) }
    const json = { id: id("msg"), type: "message", role: "assistant", model: modelOf(body), content, stop_reason, stop_sequence: null, usage }
    return {
      json,
      events: () => [
        sse({ type: "message_start", message: { ...json, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } }, "message_start"),
        ...content.flatMap((block, index) => [
          sse({ type: "content_block_start", index, content_block: "input" in block ? { ...block, input: {} } : { ...block, text: "" } }, "content_block_start"),
          sse({ type: "content_block_delta", index, delta: "input" in block ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } }, "content_block_delta"),
          sse({ type: "content_block_stop", index }, "content_block_stop"),
        ]),
        sse({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }, "message_delta"),
        sse({ type: "message_stop" }, "message_stop"),
      ],
    }
  },

  "openai-chat": (body, reply, id) => {
    const tool_calls = reply.toolCalls.map((call) => ({ id: id("call"), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }))
    const message = { role: "assistant", content: reply.text ?? null, refusal: null, ...(tool_calls.length > 0 ? { tool_calls } : {}) }
    const finish_reason = tool_calls.length > 0 ? "tool_calls" : "stop"
    const prompt = tokens(body)
    const completion = tokens(message)
    const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }
    const base = { id: id("chatcmpl"), created: CREATED, model: modelOf(body) }
    // A real stream reports usage only when asked to; the record has it either way.
    const asked = isRecord(body.stream_options) && body.stream_options.include_usage === true
    const chunk = (delta: unknown, finish: string | null = null) => sse({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...(asked ? { usage: null } : {}) })
    return {
      json: { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason, logprobs: null }], usage },
      events: () => [
        chunk({ role: "assistant", content: "", refusal: null }),
        ...(reply.text === undefined ? [] : [chunk({ content: reply.text })]),
        ...tool_calls.map((call, index) => chunk({ tool_calls: [{ index, ...call }] })),
        chunk({}, finish_reason),
        ...(asked ? [sse({ ...base, object: "chat.completion.chunk", choices: [], usage })] : []),
        "data: [DONE]\n\n",
      ],
    }
  },

  "openai-responses": (body, reply, id) => {
    const output = [
      ...(reply.text === undefined ? [] : [{ id: id("msg"), type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: reply.text, annotations: [], logprobs: [] }] }]),
      ...reply.toolCalls.map((call) => ({ id: id("fc"), type: "function_call", status: "completed", call_id: id("call"), name: call.name, arguments: JSON.stringify(call.args) })),
    ]
    const input = tokens(body)
    const produced = tokens(output)
    const usage = { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: produced, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + produced }
    const json = {
      id: id("resp"),
      object: "response",
      created_at: CREATED,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: typeof body.instructions === "string" ? body.instructions : null,
      model: modelOf(body),
      output,
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      usage,
    }
    return {
      json,
      events: () => {
        let sequence = 0
        const event = (type: string, fields: Record<string, unknown>) => sse({ type, sequence_number: sequence++, ...fields }, type)
        const started = { ...json, status: "in_progress", output: [], usage: null }
        return [
          event("response.created", { response: started }),
          event("response.in_progress", { response: started }),
          ...output.flatMap((item, output_index) => {
            const at = { item_id: item.id, output_index }
            if ("arguments" in item)
              return [
                event("response.output_item.added", { output_index, item: { ...item, status: "in_progress", arguments: "" } }),
                event("response.function_call_arguments.delta", { ...at, delta: item.arguments }),
                event("response.function_call_arguments.done", { ...at, name: item.name, arguments: item.arguments }),
                event("response.output_item.done", { output_index, item }),
              ]
            const part = item.content[0]!
            return [
              event("response.output_item.added", { output_index, item: { ...item, status: "in_progress", content: [] } }),
              event("response.content_part.added", { ...at, content_index: 0, part: { ...part, text: "" } }),
              event("response.output_text.delta", { ...at, content_index: 0, delta: part.text, logprobs: [] }),
              event("response.output_text.done", { ...at, content_index: 0, text: part.text, logprobs: [] }),
              event("response.content_part.done", { ...at, content_index: 0, part }),
              event("response.output_item.done", { output_index, item }),
            ]
          }),
          event("response.completed", { response: json }),
        ]
      },
    }
  },
}

function modelOf(body: Record<string, unknown>): string {
  return typeof body.model === "string" ? body.model : "test-model"
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
