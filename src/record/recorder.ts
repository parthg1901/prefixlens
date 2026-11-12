// The recorder: assigns each model call to a lane, builds its trace record when
// the response ends, and appends it to the trace file.

import zlib from "node:zlib"
import { canonicalizeRequest, canonicalizeRequestAsync, isRecord, type CanonicalRequest } from "../canonical.ts"
import { openTraceWriter, type Billing, type Block, type TraceRecord } from "../trace.ts"
import { apiFromBody, apiFromPath, noUsageReason, PROVIDER_OF, readResponse, recordFrom, type Api } from "./exchange.ts"

export interface RecorderOptions {
  /** Trace file to append to; `false` keeps records in memory only (use `onRecord`). */
  trace?: string | false
  /** Called with every record after it is written. */
  onRecord?: (record: TraceRecord) => void
  /** Called when a call is not recorded, with the reason. */
  onSkip?: (reason: string) => void
  /** Puts every call in this session. */
  session?: string
  /** Puts every call in this lane, instead of assigning lanes by prefix. */
  lane?: string
  /** `source.recorder` of each record: "proxy", "wrap", "observe". */
  name: string
  /** Keep identifying request fields (`metadata`, `user`, `safety_identifier`, `client_metadata`) in `params`. Default false. */
  keepIdentifiers?: boolean
  /** `billing` of every record, when the recorder knows how its calls are billed. */
  billing?: Billing
  /** Keep base64 binary parts in block content instead of their SHA-256 and size. Default false. */
  keepBinary?: boolean
}

/** Header a harness may send to choose the lane (and session) of a call itself; the proxy strips it before forwarding. */
export const LANE_HEADER = "x-prefixlens-lane"
export const SESSION_HEADER = "x-prefixlens-session"

/**
 * Request headers with which harnesses name the conversation a call belongs to (`session`) and, for a
 * subagent, the conversation that started it (`parent`). A call that carries one is recorded in that
 * session, so separate conversations through one proxy never share a lane; a subagent's calls go in
 * its root session, in lanes named `subagent:<its session id>`, as the importers name them. The
 * headers are forwarded unchanged and not written to `headers`. `x-prefixlens-session`,
 * `x-prefixlens-lane` and the recorder's own `session` and `lane` options take precedence.
 */
export const SESSION_HEADERS: readonly { harness: string; session: string; parent?: string }[] = [
  { harness: "opencode", session: "x-opencode-session-id", parent: "x-opencode-parent-session-id" },
]

export interface Pending {
  /** Ends the call: builds and writes its record from the response body (SSE text, JSON text or object). */
  finish(response: unknown): Promise<TraceRecord | undefined>
  /** Ends the call without a response (upstream error, network failure). */
  abandon(reason: string): void
}

/** What `begin` and `record` take about a call. */
export interface CallInput {
  recorder?: string
  path?: string
  body: unknown
  headers?: Headers
  startedAt?: Date
  api?: Api
  lane?: string
  session?: string
}

interface Lane {
  name: string
  session?: string
  /** Lanes of one subagent within its root session (`subagent:<id>`); undefined for the session's own. */
  group?: string
  /** The cache key of its latest call: the session-id header, else prompt_cache_key. */
  cacheKey?: string
  blocks: Block[]
  /** Calls in this lane that may still be in flight for a call beginning now: `began` and `ended` are call sequence numbers. */
  calls: { began: number; ended?: number }[]
  used: number
}

export class Recorder {
  private readonly writer
  private readonly lanes: Lane[] = []
  private clock = 0
  private sequence = 0
  // Calls are prepared one after another, so lanes are assigned in the order calls began.
  private queue: Promise<unknown> = Promise.resolve()
  // Each harness session seen with a parent header, to its parent's id, so nested subagents find their root.
  private readonly parents = new Map<string, string>()

  constructor(private readonly options: RecorderOptions) {
    this.writer = options.trace === false || options.trace === undefined ? undefined : openTraceWriter(options.trace)
  }

  get file() {
    return this.writer?.file
  }

  /**
   * Starts recording a call whose response is still streaming. Returns
   * undefined, and records nothing, when the body is not a JSON object or the
   * call is not a model call.
   *
   * The request is canonicalized once, in the background, one block per turn
   * of the event loop, so neither this request nor other open streams wait for
   * it; lanes are still assigned in the order calls began.
   */
  begin(input: CallInput): Pending | undefined {
    const call = this.read(input)
    if (!call) return undefined
    // A call is in flight for another if it had not ended when that one began, whenever either is prepared.
    const entry: { began: number; ended?: number } = { began: ++this.sequence }
    const prepared = this.queue
      .then(() => canonicalizeRequestAsync(PROVIDER_OF[call.api], call.body))
      .then((canonical) => {
        const lane = this.assignLane(canonical.blocks, call.session, call.forced, call.cacheKey, entry.began, call.group)
        lane.calls.push(entry)
        return { canonical, lane }
      })
    this.queue = prepared.catch(() => undefined)
    const end = () => {
      if (entry.ended !== undefined) return false
      entry.ended = this.sequence
      return true
    }
    return {
      // The call ends when the response does, not when its preparation catches up.
      finish: async (response) => {
        if (!end()) return undefined
        const { canonical, lane } = await prepared
        return this.write(call, canonical, lane, response)
      },
      abandon: (reason) => {
        if (end()) void prepared.then(() => this.options.onSkip?.(`not recorded: ${reason}`))
      },
    }
  }

  /** Records a call whose response is complete, at once (`lens.observe`). Returns undefined when it cannot be recorded. */
  record(input: CallInput, response: unknown): TraceRecord | undefined {
    const call = this.read(input)
    if (!call) return undefined
    const canonical = canonicalizeRequest(PROVIDER_OF[call.api], call.body)
    return this.write(call, canonical, this.assignLane(canonical.blocks, call.session, call.forced, call.cacheKey, ++this.sequence, call.group), response)
  }

  private read(input: CallInput) {
    const pathApi = input.path === undefined ? undefined : apiFromPath(input.path)
    if (input.path !== undefined && !pathApi) return undefined
    const body = readBody(input.body, input.headers?.get("content-encoding") ?? undefined)
    if (!body) {
      if (pathApi) this.options.onSkip?.(`not recorded: the ${input.path} request body is not a JSON object`)
      return undefined
    }
    const harness = this.harnessSession(input.headers)
    return {
      api: input.api ?? pathApi ?? apiFromBody(body),
      body,
      startedAt: input.startedAt ?? new Date(),
      session: input.session ?? input.headers?.get(SESSION_HEADER) ?? this.options.session ?? harness?.session,
      forced: input.lane ?? input.headers?.get(LANE_HEADER) ?? this.options.lane,
      group: harness?.group,
      cacheKey: input.headers?.get("session-id") ?? (typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined),
      headers: input.headers,
      recorder: input.recorder ?? this.options.name,
    }
  }

  /** The session and lane group a harness's own session headers give a call: its root session, and `subagent:<id>` for a subagent. */
  private harnessSession(headers: Headers | undefined): { session: string; group?: string } | undefined {
    for (const names of SESSION_HEADERS) {
      const own = headers?.get(names.session)
      if (!own) continue
      const parent = names.parent ? headers?.get(names.parent) : null
      if (parent) this.parents.set(own, parent)
      let root = own
      for (const seen = new Set([own]); this.parents.has(root) && !seen.has(this.parents.get(root)!); seen.add(root)) root = this.parents.get(root)!
      return root === own ? { session: own } : { session: root, group: `subagent:${own}` }
    }
    return undefined
  }

  private write(call: NonNullable<ReturnType<Recorder["read"]>>, canonical: CanonicalRequest, lane: Lane, response: unknown): TraceRecord | undefined {
    const input = {
      api: call.api,
      body: call.body,
      response: readResponse(call.api, response),
      startedAt: call.startedAt,
      ...(call.headers ? { headers: call.headers } : {}),
      ...(call.session ? { session: call.session } : {}),
      lane: lane.name,
      recorder: call.recorder,
      ...(this.options.keepIdentifiers ? { keepIdentifiers: true } : {}),
      ...(this.options.billing ? { billing: this.options.billing } : {}),
      ...(this.options.keepBinary ? { keepBinary: true } : {}),
    }
    const unusable = noUsageReason(input)
    if (unusable) {
      this.options.onSkip?.(`not recorded: ${unusable}`)
      return undefined
    }
    const built = recordFrom(input, canonical)
    this.writer?.append(built)
    this.options.onRecord?.(built)
    return built
  }

  /**
   * Calls that build on each other's prefix belong in one lane; independent
   * conversations through the same proxy (subagents, side queries) need their
   * own, or each would be compared with the other. A call joins:
   * 1. the lane whose latest request is an unchanged prefix of it (the usual case);
   * 2. else the lane it shares the most leading messages with (an edit, a tool-list change);
   * 3. else an idle lane with the same tools and system prompt (compaction, rewind);
   * 4. else a new lane.
   * Rules 2 and 3 skip a lane whose cache key differs: a harness that names its
   * conversations (Codex sends its thread id as session-id) started another one.
   */
  private assignLane(blocks: Block[], session: string | undefined, forced: string | undefined, cacheKey: string | undefined, began: number, group?: string): Lane {
    const candidates = this.lanes.filter((lane) => lane.session === session && (forced !== undefined || lane.group === group))
    // Calls that ended before this one began can never be in flight for a later call either.
    for (const lane of candidates) lane.calls = lane.calls.filter((other) => other.ended === undefined || other.ended >= began)
    const chosen = forced !== undefined ? candidates.find((lane) => lane.name === forced) : pickLane(candidates, blocks, cacheKey, began)
    const lane = chosen ?? this.newLane(forced, session, group)
    lane.blocks = blocks
    if (cacheKey === undefined) delete lane.cacheKey
    else lane.cacheKey = cacheKey
    lane.used = ++this.clock
    return lane
  }

  private newLane(name: string | undefined, session: string | undefined, group: string | undefined): Lane {
    const count = this.lanes.filter((lane) => lane.session === session && lane.group === group).length
    const base = group ?? "main"
    const lane = { name: name ?? (count === 0 ? base : group ? `${group}:${count + 1}` : `lane-${count + 1}`), ...(session ? { session } : {}), ...(group && !name ? { group } : {}), blocks: [], calls: [], used: 0 }
    this.lanes.push(lane)
    return lane
  }
}

function pickLane(lanes: Lane[], blocks: Block[], cacheKey: string | undefined, began: number): Lane | undefined {
  const hashes = (list: Block[], kind: Block["kind"]) => list.filter((block) => block.kind === kind).map((block) => block.hash).join()
  const scored = lanes.map((lane) => {
    const shared = sharedPrefix(lane.blocks, blocks)
    const messages = sharedPrefix(
      lane.blocks.filter((block) => block.kind === "message"),
      blocks.filter((block) => block.kind === "message"),
    )
    const sameTools = hashes(lane.blocks, "tool") === hashes(blocks, "tool")
    const sameSystem = hashes(lane.blocks, "system") === hashes(blocks, "system")
    const idle = lane.calls.every((other) => other.ended !== undefined && other.ended < began)
    const sameKey = lane.cacheKey === undefined || cacheKey === undefined || lane.cacheKey === cacheKey
    // A call running alongside the lane's latest one is another conversation unless it shares the start of the request.
    const related = sameKey && (shared > 0 || (idle && (sameTools || sameSystem)))
    const score =
      shared === lane.blocks.length && shared > 0 ? 3e6 + shared : messages > 0 && related ? 2e6 + messages : sameKey && idle && sameTools && sameSystem ? 1e6 : -1
    return { lane, score }
  })
  const best = scored.filter((entry) => entry.score >= 0).sort((a, b) => b.score - a.score || b.lane.used - a.lane.used)[0]
  return best?.lane
}

function sharedPrefix(a: Block[], b: Block[]): number {
  let index = 0
  while (index < a.length && index < b.length && a[index]!.hash === b[index]!.hash) index++
  return index
}

// Request bodies arrive as text, bytes (possibly compressed: the ChatGPT sign-in flow accepts zstd) or an object.
function readBody(body: unknown, encoding: string | undefined): Record<string, unknown> | undefined {
  if (body instanceof Uint8Array) return readBody(decode(body, encoding), undefined)
  if (isRecord(body)) return body
  const text = typeof body === "string" ? body : undefined
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function decode(bytes: Uint8Array, encoding: string | undefined): string | undefined {
  const name = encoding?.trim().toLowerCase() ?? "identity"
  const inflate: Record<string, (data: Uint8Array) => Uint8Array> = {
    identity: (data) => data,
    gzip: zlib.gunzipSync,
    deflate: zlib.inflateSync,
    br: zlib.brotliDecompressSync,
    zstd: zlib.zstdDecompressSync,
  }
  const decoder = inflate[name]
  if (!decoder) return undefined
  try {
    return Buffer.from(decoder(bytes)).toString("utf8")
  } catch {
    return undefined
  }
}
