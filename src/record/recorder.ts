// The recorder: assigns each model call to a lane, builds its trace record when
// the response ends, and appends it to the trace file.

import zlib from "node:zlib"
import { canonicalizeRequest, canonicalizeRequestAsync, isRecord, type CanonicalRequest } from "../canonical.ts"
import { openTraceWriter, type Billing, type TraceRecord } from "../trace.ts"
import { apiFromBody, apiFromPath, noUsageReason, PROVIDER_OF, readResponse, recordFrom, type Api } from "./exchange.ts"
import { Lanes, type Lane } from "./lanes.ts"

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
  /** Lane rule 4 (`Lanes`): also continue an idle lane that starts with the same block. For the test session; default false. */
  joinOnSharedStart?: boolean
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

export class Recorder {
  private readonly writer
  private readonly lanes: Lanes
  private sequence = 0
  // Calls are prepared one after another, so lanes are assigned in the order calls began.
  private queue: Promise<unknown> = Promise.resolve()
  // Each harness session seen with a parent header, to its parent's id, so nested subagents find their root.
  private readonly parents = new Map<string, string>()
  private readonly options: RecorderOptions

  constructor(options: RecorderOptions) {
    this.options = options
    this.lanes = new Lanes(options.joinOnSharedStart ? { joinOnSharedStart: true } : {})
    this.writer = options.trace === false || options.trace === undefined ? undefined : openTraceWriter(options.trace)
    // A trace that already has records (a proxy restarted on the same file) holds conversations this
    // recorder may be asked to continue: without their lanes, its first call would open `main` again and
    // be compared with whatever that lane held before, not with the call it follows.
    for (const lane of this.writer?.lanes() ?? []) {
      // The recorder names a subagent's lanes `subagent:<id>`, then `subagent:<id>:2` and so on.
      const group = /^subagent:[^:]+/.exec(lane.name)?.[0]
      this.lanes.restore({ name: lane.name, ...(lane.session ? { session: lane.session } : {}), ...(group ? { group } : {}), ...(lane.cacheKey === undefined ? {} : { cacheKey: lane.cacheKey }), blocks: lane.blocks })
    }
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
        const lane = this.lanes.assign(canonical.blocks, { ...laneCall(call), began: entry.began })
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
    return this.open(input)?.finish(response)
  }

  /**
   * Starts a call at once and says which lane it is in before its response exists: the test session
   * chooses its reply knowing the lane. `finish` builds and writes the record, as `record` does.
   * Returns undefined when the call cannot be recorded.
   */
  open(input: CallInput): { lane: string; finish(response: unknown): TraceRecord | undefined } | undefined {
    const call = this.read(input)
    if (!call) return undefined
    const canonical = canonicalizeRequest(PROVIDER_OF[call.api], call.body)
    const lane = this.lanes.assign(canonical.blocks, { ...laneCall(call), began: ++this.sequence })
    return { lane: lane.name, finish: (response) => this.write(call, canonical, lane, response) }
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
}

function laneCall(call: { session?: string | undefined; forced?: string | undefined; cacheKey?: string | undefined; group?: string | undefined }) {
  return {
    ...(call.session === undefined ? {} : { session: call.session }),
    ...(call.forced === undefined ? {} : { forced: call.forced }),
    ...(call.cacheKey === undefined ? {} : { cacheKey: call.cacheKey }),
    ...(call.group === undefined ? {} : { group: call.group }),
  }
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
