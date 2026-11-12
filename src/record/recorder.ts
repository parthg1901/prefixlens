// The recorder: assigns each model call to a lane, builds its trace record when
// the response ends, and appends it to the trace file.

import zlib from "node:zlib"
import { canonicalizeRequest, isRecord } from "../canonical.ts"
import { openTraceWriter, type Block, type TraceRecord } from "../trace.ts"
import { apiFromBody, apiFromPath, buildRecord, PROVIDER_OF, readResponse, type Api } from "./exchange.ts"

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
}

/** Header a harness may send to choose the lane (and session) of a call itself; the proxy strips it before forwarding. */
export const LANE_HEADER = "x-prefixlens-lane"
export const SESSION_HEADER = "x-prefixlens-session"

export interface Pending {
  /** Ends the call: builds and writes its record from the response body (SSE text, JSON text or object). */
  finish(response: unknown): TraceRecord | undefined
  /** Ends the call without a response (upstream error, network failure). */
  abandon(reason: string): void
}

interface Lane {
  name: string
  session?: string
  /** The cache key of its latest call: the session-id header, else prompt_cache_key. */
  cacheKey?: string
  blocks: Block[]
  inFlight: number
  used: number
}

export class Recorder {
  private readonly writer
  private readonly lanes: Lane[] = []
  private clock = 0

  constructor(private readonly options: RecorderOptions) {
    this.writer = options.trace === false || options.trace === undefined ? undefined : openTraceWriter(options.trace)
  }

  get file() {
    return this.writer?.file
  }

  /**
   * Starts recording a call. Returns undefined, and records nothing, when the
   * body is not a JSON object or the call is not a model call.
   */
  begin(input: { recorder?: string; path?: string; body: unknown; headers?: Headers; startedAt?: Date; api?: Api; lane?: string; session?: string }): Pending | undefined {
    const pathApi = input.path === undefined ? undefined : apiFromPath(input.path)
    if (input.path !== undefined && !pathApi) return undefined
    const body = readBody(input.body, input.headers?.get("content-encoding") ?? undefined)
    if (!body) {
      if (pathApi) this.options.onSkip?.(`not recorded: the ${input.path} request body is not a JSON object`)
      return undefined
    }
    const api = input.api ?? pathApi ?? apiFromBody(body)
    const startedAt = input.startedAt ?? new Date()
    const session = input.session ?? input.headers?.get(SESSION_HEADER) ?? this.options.session
    const cacheKey = input.headers?.get("session-id") ?? (typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined)
    const lane = this.assignLane(canonicalizeRequest(PROVIDER_OF[api], body).blocks, session, input.lane ?? input.headers?.get(LANE_HEADER) ?? this.options.lane, cacheKey)
    lane.inFlight++
    let done = false
    const end = () => {
      if (done) return false
      done = true
      lane.inFlight--
      return true
    }
    return {
      finish: (response) => {
        if (!end()) return undefined
        const built = buildRecord({ api, body, response: readResponse(api, response), startedAt, ...(input.headers ? { headers: input.headers } : {}), ...(session ? { session } : {}), lane: lane.name, recorder: input.recorder ?? this.options.name })
        if (typeof built === "string") {
          this.options.onSkip?.(`not recorded: ${built}`)
          return undefined
        }
        this.writer?.append(built)
        this.options.onRecord?.(built)
        return built
      },
      abandon: (reason) => {
        if (end()) this.options.onSkip?.(`not recorded: ${reason}`)
      },
    }
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
  private assignLane(blocks: Block[], session: string | undefined, forced: string | undefined, cacheKey: string | undefined): Lane {
    const candidates = this.lanes.filter((lane) => lane.session === session)
    const chosen = forced !== undefined ? candidates.find((lane) => lane.name === forced) : pickLane(candidates, blocks, cacheKey)
    const lane = chosen ?? this.newLane(forced, session)
    lane.blocks = blocks
    if (cacheKey === undefined) delete lane.cacheKey
    else lane.cacheKey = cacheKey
    lane.used = ++this.clock
    return lane
  }

  private newLane(name: string | undefined, session: string | undefined): Lane {
    const count = this.lanes.filter((lane) => lane.session === session).length
    const lane = { name: name ?? (count === 0 ? "main" : `lane-${count + 1}`), ...(session ? { session } : {}), blocks: [], inFlight: 0, used: 0 }
    this.lanes.push(lane)
    return lane
  }
}

function pickLane(lanes: Lane[], blocks: Block[], cacheKey: string | undefined): Lane | undefined {
  const hashes = (list: Block[], kind: Block["kind"]) => list.filter((block) => block.kind === kind).map((block) => block.hash).join()
  const scored = lanes.map((lane) => {
    const shared = sharedPrefix(lane.blocks, blocks)
    const messages = sharedPrefix(
      lane.blocks.filter((block) => block.kind === "message"),
      blocks.filter((block) => block.kind === "message"),
    )
    const sameTools = hashes(lane.blocks, "tool") === hashes(blocks, "tool")
    const sameSystem = hashes(lane.blocks, "system") === hashes(blocks, "system")
    const idle = lane.inFlight === 0
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
