// The test session of "prefixlens/test": a fetch that stands in for the model
// provider, so a test can run a framework or an agent loop with no network,
// keep every request it sends, and assert that each one extends the request
// before it in the same conversation.
//
// No test-runner imports and no globals: it works the same under node:test,
// bun:test, vitest and jest.

import { explainPair, keptBy, PrefixBreakError, type PrefixExplanation, type PrefixOptions, type RequestLike } from "./assert.ts"
import { canonicalizeRequest, isRecord } from "./canonical.ts"
import { estimateTokens as tokens } from "./estimate.ts"
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
  /** The step it was sent in: the name last given to `session.step()` before the call was made. Absent before the first step. */
  step?: string
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
  /**
   * Intentional breaks by step: a step's name to what `allowBreak` takes, e.g. `{ compaction: "compaction" }`.
   * It allows one break per step of that name: the first call in the step whose prefix changed, in any lane.
   * A later change in the same step, or a change in any other step, still fails. `allowBreakAt` for a call
   * comes before it.
   */
  allowBreakIn?: Record<string, AllowedBreak>
}

/** `assertSessionStable`'s options: those of `session.assertStable()`, and the steps of the bodies. */
export interface SessionStableOptions extends StabilityOptions {
  /**
   * Where each step begins: a call number (a position in `bodies`, from 1) to the step's name, e.g.
   * `{ 1: "first question", 4: "reload instructions" }`. A step holds its first call and every call up to
   * the next step. Bodies before the first one have no step.
   */
  steps?: Record<number, string>
}

/**
 * How one call compares with the call before it in its lane. A call that continues a conversation the
 * provider keeps is not compared (`notChecked`); the next call sent in full is compared with the last
 * one that was.
 */
export interface CallExplanation extends PrefixExplanation {
  /** The later call's number. */
  call: number
  /** The call it is compared with: the one before it in the same lane. */
  previous: number
  lane: string
  /**
   * Set when the call opens its lane and is compared with a call of another one: that lane. The call changed its
   * tools and its instructions together, so it shares no start with that lane's requests and is not in it, but it
   * holds replies of its conversation: it is that conversation's next request.
   */
  follows?: string
  /** The step the later call was sent in. Absent for a call sent before the first step. */
  step?: string
}

/**
 * What a step's calls came to, the worst first: `"break"` (a change that is not allowed), `"not checked"`
 * (a call continues a conversation the provider keeps), `"allowed"`, `"stable"`, `"nothing to compare"`
 * (each call is the first of its lane) or `"no calls"`.
 */
export type StepStatus = "break" | "not checked" | "allowed" | "stable" | "nothing to compare" | "no calls"

/** One step of a session, with its calls and how they compare with the calls before them. */
export interface StepResult {
  /** Its name, as given to `session.step()`; undefined for the calls sent before the first step. */
  step: string | undefined
  /** The calls sent in it. */
  calls: number[]
  status: StepStatus
  /** The result in one line, as the summary prints it, e.g. `break at call 3: system prompt changed (1 → 2 parts)`. */
  result: string
  /** The comparisons of its calls, as `explain()` gives them. */
  explanations: CallExplanation[]
}

/** One result per step of a session. */
export interface SessionSummary {
  /** In the order they were marked; the calls before the first step, if any, come first. */
  steps: StepResult[]
  /** The steps as a table to print, one line each. */
  text: string
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
  /**
   * Marks what the test does next: every call made after it, until the next `step()`, belongs to the step
   * `name`. Failure messages, `explain()` and `summary()` name it, and `allowBreakIn` allows a break by it.
   * Call it just before the action, e.g. `session.step("reload instructions")`.
   */
  step(name: string): void
  /** Compares each call with the one before it in its lane. Never throws for a change, or for a call it cannot check; `ok` says whether it is allowed. */
  explain(options?: StabilityOptions): CallExplanation[]
  /** One result per step, from the comparisons `explain()` makes. Never throws for a change. */
  summary(options?: StabilityOptions): SessionSummary
  /**
   * Throws a `PrefixBreakError` naming the first call that does not keep the prefix of the call before it in
   * its lane; in a session with steps, the message also lists every step that breaks. Also throws when a call
   * could not be checked (it continues a conversation the provider keeps), when a step recorded no call, when
   * there was nothing to compare, or when a request could not be answered. Returns the explanations otherwise.
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
  // The steps marked so far, in order; the same name marked twice is two steps.
  const steps: string[] = []
  // The step of each call, by its index in `steps`.
  const stepOf: (number | undefined)[] = []
  // For a call that opens a lane: the lane whose conversation it carries on (what tells it apart), if any.
  const followsOf: (string | undefined)[] = []
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
    // The step the call was made in, read before anything is awaited: the test may mark the next one meanwhile.
    const marked = steps.length === 0 ? undefined : steps.length - 1
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
    // A harness that names its sessions in a header has lanes per session.
    const request: RecordedRequest = { call: requests.length + 1, format, lane: call.session ? `${call.session}/${call.lane}` : call.lane, url, body, ...(marked === undefined ? {} : { step: steps[marked]! }) }
    const reply = readReply(script, request)
    if (typeof reply === "string") return refuse(reply)
    const answer = ANSWERS[format](body, reply, id)
    requests.push(request)
    stepOf.push(marked)
    followsOf.push(call.follows === undefined ? undefined : laneKey({ ...(call.session ? { session: call.session } : {}), lane: call.follows }))
    // The reply always reports usage, so the call always has a record.
    records.push(call.finish(answer.json)!)
    if (body.stream !== true) return Response.json(answer.json)
    return new Response(answer.events().join(""), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
  }

  const calls = (): Call[] =>
    records.map((record, index) => ({
      call: index + 1,
      lane: laneKey(record),
      name: requests[index]!.lane,
      request: record,
      ...(followsOf[index] === undefined ? {} : { follows: followsOf[index] }),
      ...(stepOf[index] === undefined ? {} : { step: stepOf[index] }),
    }))
  const explain = (given: StabilityOptions = {}) => explainCalls(calls(), given, steps).explanations
  return {
    fetch,
    requests,
    step(name) {
      if (typeof name !== "string" || name.trim() === "") throw new TypeError(`prefixlens test session: session.step(name) takes the name of what the test does next, as a non-empty string; it was given ${JSON.stringify(name) ?? String(name)}`)
      steps.push(name)
    },
    explain,
    summary(given = {}) {
      const all = calls()
      return summarize(all, explainCalls(all, given, steps), steps)
    },
    assertStable(given = {}) {
      if (problems.length > 0) throw new Error(problems.length === 1 ? problems[0] : `${problems[0]}\n(${problems.length - 1} more: ${problems.slice(1).join("; ")})`)
      if (requests.length === 0)
        throw new Error("prefixlens test session: no request was recorded, so there is nothing to check. Give session.fetch to the model provider your agent uses, e.g. createAnthropic({ fetch: session.fetch }).")
      const all = calls()
      return assertCalls(all, explainCalls(all, given, steps), steps)
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
 * `steps` says where each step begins, and the messages then name the steps as a session's do.
 */
export function assertSessionStable(bodies: readonly Record<string, unknown>[], options: SessionStableOptions = {}): CallExplanation[] {
  const { steps: marks, ...given } = options
  const lanes = new Lanes({ joinOnSharedStart: true })
  const calls: Call[] = bodies.map((body, index) => {
    if (!isRecord(body)) throw new TypeError(`assertSessionStable: bodies[${index}] is not a request body object`)
    const canonical = canonicalizeRequest(options.provider ?? PROVIDER_OF[apiFromBody(body)], body)
    const kept = keptBy(body)
    const lane = lanes.assign(canonical.blocks, { began: index + 1, ...(typeof body.prompt_cache_key === "string" ? { cacheKey: body.prompt_cache_key } : {}), ...(kept ? { continues: kept.id } : {}) })
    return { call: index + 1, lane: lane.name, name: lane.name, ...(lane.first === index + 1 && lane.follows ? { follows: lane.follows } : {}), request: body }
  })
  if (calls.length === 0) throw new Error("assertSessionStable: no request bodies were given, so there is nothing to check")
  const starts = stepStarts(marks, calls.length)
  for (const call of calls) {
    const step = starts.findLastIndex(([first]) => first <= call.call)
    if (step >= 0) call.step = step
  }
  const steps = starts.map(([, name]) => name)
  return assertCalls(calls, explainCalls(calls, given, steps), steps)
}

/** `assertSessionStable`'s `steps`, checked, as [first call, name] in call order. */
function stepStarts(marks: Record<number, string> | undefined, count: number): [number, string][] {
  if (marks === undefined) return []
  if (!isRecord(marks)) throw new TypeError("assertSessionStable: steps is not an object of call numbers to step names, e.g. { 1: \"first question\", 4: \"compaction\" }")
  return Object.entries(marks)
    .map(([key, name]): [number, string] => {
      const number = Number(key)
      if (!Number.isInteger(number) || number < 1 || number > count)
        throw new TypeError(`assertSessionStable: steps names call ${key}, but there ${count === 1 ? "is 1 call" : `are ${count} calls`} (numbered from 1)`)
      if (typeof name !== "string" || name.trim() === "") throw new TypeError(`assertSessionStable: the step at call ${key} has no name; give each step a non-empty string`)
      return [number, name]
    })
    .toSorted((a, b) => a[0] - b[0])
}

interface Call {
  call: number
  /** What tells lanes apart. */
  lane: string
  /** The lane as shown. */
  name: string
  /**
   * For the call that opens a lane: the lane (what tells it apart) whose conversation it carries on. Such a call
   * changed its tools and its instructions together, so nothing at the start of its request is that lane's and it
   * is not in it; it is that conversation's next request all the same, and is compared with its latest one.
   */
  follows?: string
  request: RequestLike
  /** Its step, as an index into the session's steps. */
  step?: number
}

type Explained = ReturnType<typeof explainCalls>

/** A call that was not compared, and the request field that says why. */
interface Unchecked {
  call: number
  by: string
}

function explainCalls(calls: Call[], options: StabilityOptions, steps: readonly string[]): { explanations: CallExplanation[]; unchecked: Unchecked[] } {
  const { allowBreakAt, allowBreakIn, ...shared } = options
  // Per lane: its latest call, and its latest call that carried the conversation in full.
  const latest = new Map<string, Call>()
  const full = new Map<string, Call>()
  const unchecked: Unchecked[] = []
  const pairs = calls.flatMap((next) => {
    const kept = keptBy(next.request)
    // A call the provider continues has nothing to be compared with; it is listed against the call before it.
    const previous = (kept ? latest : full).get(next.lane) ?? (next.follows === undefined ? undefined : full.get(next.follows))
    latest.set(next.lane, next)
    if (kept) unchecked.push({ call: next.call, by: kept.by })
    else full.set(next.lane, next)
    return previous ? [{ previous, next }] : []
  })
  for (const key of Object.keys(allowBreakAt ?? {})) {
    const number = Number(key)
    if (!Number.isInteger(number) || number < 1 || number > calls.length)
      throw new TypeError(`prefixlens/test: allowBreakAt names call ${key}, but there ${calls.length === 1 ? "is 1 call" : `are ${calls.length} calls`} (numbered from 1)`)
    if (!pairs.some((pair) => pair.next.call === number))
      throw new TypeError(`prefixlens/test: allowBreakAt names call ${key}, but it is the first call of its lane ("${calls[number - 1]!.name}"): there is no earlier request for it to break`)
  }
  const nameOf = (call: Call) => (call.step === undefined ? undefined : steps[call.step])
  const named = allowBreakIn ?? {}
  for (const name of Object.keys(named)) {
    if (!steps.includes(name))
      throw new TypeError(
        `prefixlens/test: allowBreakIn names step ${quote(name)}, but ${steps.length === 0 ? "no step was marked (session.step(name) marks one)" : `no step has that name (the steps: ${[...new Set(steps)].map(quote).join(", ")})`}`,
      )
    if (!pairs.some((pair) => nameOf(pair.next) === name))
      throw new TypeError(
        `prefixlens/test: allowBreakIn names step ${quote(name)}, but ${calls.some((call) => nameOf(call) === name) ? "each call in it is the first of its lane: there is no earlier request for it to break" : "it recorded no call"}`,
      )
  }
  // A step named in allowBreakIn allows one break: its first call whose prefix changed takes the allowance.
  const taken = new Map<number, number>()
  const explanations = pairs.map(({ previous, next }) => {
    const step = nameOf(next)
    const allowance = step !== undefined && Object.hasOwn(named, step) ? named[step] : undefined
    const takenBy = next.step === undefined ? undefined : taken.get(next.step)
    const allowBreak = allowBreakAt?.[next.call] ?? (allowance !== undefined && takenBy === undefined ? allowance : shared.allowBreak)
    const where = step === undefined ? `lane ${next.name}` : `step ${quote(step)}, lane ${next.name}`
    // The first call of a lane, compared with the conversation it carries on in another lane.
    const across = previous.lane === next.lane ? "" : ` of lane ${previous.name}, whose conversation it carries on`
    const allow =
      step === undefined
        ? `pass { allowBreakAt: { ${next.call}: { reason: "..." } } }`
        : allowance !== undefined && takenBy !== undefined
          ? `give it a step of its own: step ${quote(step)} allows one break, and call ${takenBy} took it`
          : `pass { allowBreakIn: { ${quote(step)}: { reason: "..." } } }`
    const explanation = explainPair(previous.request, next.request, { ...shared, ...(allowBreak === undefined ? {} : { allowBreak }) }, {
      heading: `prefix not stable at call ${next.call} (${where}, compared with call ${previous.call}${across})`,
      allow,
      skipped: `call ${next.call} not checked (${where})`,
    })
    if (allowance !== undefined && takenBy === undefined && !explanation.stable && !explanation.notChecked) taken.set(next.step!, next.call)
    return { call: next.call, previous: previous.call, lane: next.name, ...(across === "" ? {} : { follows: previous.name }), ...(step === undefined ? {} : { step }), ...explanation }
  })
  return { explanations, unchecked }
}

function assertCalls(calls: Call[], { explanations, unchecked }: Explained, steps: readonly string[]): CallExplanation[] {
  const count = calls.length
  const [first, ...others] = explanations.filter((explanation) => !explanation.ok && !explanation.notChecked)
  if (first) {
    let more: string
    if (steps.length === 0) {
      const listed = others.slice(0, 5).map((other) => `call ${other.call} (${other.change?.summary})`)
      more = others.length === 0 ? "" : `\n\n  ${others.length === 1 ? "1 more call changes" : `${others.length} more calls change`} the prefix: ${printable(listed.join(", "))}${others.length > listed.length ? ", …" : ""}`
    } else {
      // Every step that breaks, one line each, after the first break's full message.
      const rows = summarize(calls, { explanations, unchecked }, steps).steps
      const broken = rows.filter((row) => row.status === "break")
      more = `\n\n  ${broken.length} of ${rows.length} ${rows.length === 1 ? "step breaks" : `steps ${broken.length === 1 ? "breaks" : "break"}`} the prefix:\n\n${table(broken, "    ")}`
    }
    throw new PrefixBreakError({ ...first, message: first.message + more })
  }
  // A test that compared only some of its calls must not pass as if it had compared them all.
  if (unchecked.length > 0) {
    const by = [...new Set(unchecked.map((entry) => entry.by))].join(", ")
    const names = [...new Set(unchecked.flatMap((entry) => (calls[entry.call - 1]!.step === undefined ? [] : [steps[calls[entry.call - 1]!.step!]!])))]
    const inSteps = names.length === 0 ? "" : `, in ${names.length === 1 ? "step" : "steps"} ${names.map(quote).join(", ")}`
    throw new Error(
      `prefixlens/test: ${unchecked.length} of the ${count} calls ${unchecked.length === 1 ? "was" : "were"} not checked (${numbered(unchecked.map((entry) => entry.call))}${inSteps}): ${unchecked.length === 1 ? "it continues" : "each continues"} a conversation the provider keeps (${by}), so its request carries only what is new and there is nothing to compare it with.\n\n  Run the agent with that turned off, so that every request carries the conversation in full, and say that the path the provider keeps is not covered by this test.`,
    )
  }
  // A step that recorded no call checked nothing, and the calls it was meant for are counted in the next one.
  const empty = steps.filter((_, index) => !calls.some((call) => call.step === index))
  if (empty.length > 0)
    throw new Error(
      `prefixlens/test: ${empty.length === 1 ? `step ${quote(empty[0]!)} recorded no call, so nothing in it was` : `${empty.length} steps recorded no call (${empty.map(quote).join(", ")}), so nothing in them was`} checked. A step holds the calls made after session.step() marks it and before the next mark: mark it just before the action, and make the call that shows the change before marking the next step.`,
    )
  if (explanations.length === 0)
    throw new Error(
      `prefixlens/test: nothing to compare: ${count === 1 ? "1 request was recorded" : `each of the ${count} requests is the first of its lane`}. A conversation needs at least two model calls (a second user message, or a tool call and its result) before its prefix can be checked.`,
    )
  return explanations
}

/** One result per step: the calls before the first step (if any), then each step in the order it was marked. */
function summarize(calls: Call[], { explanations }: Explained, steps: readonly string[]): SessionSummary {
  const groups: (number | undefined)[] = [...(calls.some((call) => call.step === undefined) ? [undefined] : []), ...steps.map((_, index) => index)]
  const rows = groups.map((index): StepResult => {
    const own = calls.filter((call) => call.step === index).map((call) => call.call)
    const compared = explanations.filter((explanation) => own.includes(explanation.call))
    return { step: index === undefined ? undefined : steps[index], calls: own, ...verdict(own, compared), explanations: compared }
  })
  return { steps: rows, text: table(rows) }
}

function verdict(calls: number[], compared: CallExplanation[]): { status: StepStatus; result: string } {
  if (calls.length === 0) return { status: "no calls", result: "no calls" }
  const broken = compared.filter((explanation) => !explanation.ok && !explanation.notChecked)
  if (broken.length > 0) {
    const also = broken.length === 1 ? "" : `; also at ${numbered(broken.slice(1).map((explanation) => explanation.call))}`
    return { status: "break", result: `break at call ${broken[0]!.call}: ${broken[0]!.change?.summary}${also}` }
  }
  const skipped = compared.filter((explanation) => explanation.notChecked)
  if (skipped.length > 0) return { status: "not checked", result: `not checked at ${numbered(skipped.map((explanation) => explanation.call))}: ${skipped.length === 1 ? "it continues" : "each continues"} a conversation the provider keeps` }
  const allowed = compared.filter((explanation) => !explanation.stable)
  if (allowed.length > 0) return { status: "allowed", result: `allowed at ${numbered(allowed.map((explanation) => explanation.call))} (${allowed[0]!.allowed}): ${allowed[0]!.change?.summary}` }
  if (compared.length > 0) return { status: "stable", result: "stable" }
  return { status: "nothing to compare", result: `nothing to compare: ${calls.length === 1 ? "the call is the first of its lane" : "each call is the first of its lane"}` }
}

/** Steps as aligned columns, with a heading line. */
function table(rows: StepResult[], indent = ""): string {
  const cells = [["step", "calls", "result"], ...rows.map((row) => [row.step ?? "(no step)", row.calls.length === 0 ? "-" : ranges(row.calls), row.result])]
  const width = (column: number) => Math.max(...cells.map((cell) => cell[column]!.length))
  const [name, numbers] = [width(0), width(1)]
  return printable(cells.map(([step, calls, result]) => `${indent}${step!.padEnd(name)}  ${calls!.padEnd(numbers)}  ${result}`).join("\n"))
}

function quote(name: string): string {
  return JSON.stringify(name)
}

/** Call numbers as ranges: "call 2", "calls 2-9, 12". */
function numbered(calls: number[]): string {
  return `${calls.length === 1 ? "call" : "calls"} ${ranges(calls)}`
}

/** Numbers as ranges: "2", "2-9, 12". */
function ranges(numbers: number[]): string {
  const runs: [number, number][] = []
  for (const number of numbers) {
    const run = runs.at(-1)
    if (run && number === run[1] + 1) run[1] = number
    else runs.push([number, number])
  }
  return runs.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ")
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
