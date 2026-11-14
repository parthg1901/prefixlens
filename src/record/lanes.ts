// Lane assignment: which earlier call a new call continues. One implementation,
// shared by the recorder (the proxy, `wrap`, `lens.fetch`, `lens.observe`) and
// the test session of "prefixlens/test".

import { prefixBlocks, type Block } from "../trace.ts"

export interface Lane {
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

/** What is known about a call when its lane is chosen. */
export interface LaneCall {
  session?: string
  /** The lane the caller named; no lane is chosen by prefix then. */
  forced?: string
  cacheKey?: string
  /** The call's sequence number. */
  began: number
  group?: string
}

export interface LanesOptions {
  /**
   * Also continue an idle lane whose latest request starts with the same block (the same first tool, or
   * the same first system part), when no other rule finds one. For a test of one harness, where a
   * request that changes its system prompt and the start of its history at once is far likelier to be
   * that harness breaking its prefix than a second conversation: the break is then reported, not
   * hidden in a lane of its own. Off for the proxy, where independent agents that share a tool run
   * side by side.
   */
  joinOnSharedStart?: boolean
}

export class Lanes {
  private readonly lanes: Lane[] = []
  private clock = 0
  private readonly options: LanesOptions

  constructor(options: LanesOptions = {}) {
    this.options = options
  }

  /** Adds a lane that already exists, with its latest request: one a trace file being appended to holds. */
  restore(lane: Omit<Lane, "calls" | "used">) {
    this.lanes.push({ ...lane, blocks: prefixBlocks(lane.blocks), calls: [], used: ++this.clock })
  }

  /**
   * Calls that build on each other's prefix belong in one lane; independent
   * conversations through the same proxy (subagents, side queries) need their
   * own, or each would be compared with the other. A call joins:
   * 1. the lane whose latest request is an unchanged prefix of it (the usual case);
   * 2. else the lane it shares the most leading messages with (an edit, a tool-list change);
   * 3. else an idle lane with the same tools and system prompt (compaction, rewind);
   * 4. else, with `joinOnSharedStart`, an idle lane whose latest request starts with the same block;
   * 5. else a new lane.
   * Rules 2 to 4 skip a lane whose cache key differs: a harness that names its
   * conversations (Codex sends its thread id as session-id) started another one.
   */
  assign(sent: Block[], call: LaneCall): Lane {
    // Lanes follow the prompt prefix, which deferred tools are not part of.
    const blocks = prefixBlocks(sent)
    const candidates = this.lanes.filter((lane) => lane.session === call.session && (call.forced !== undefined || lane.group === call.group))
    // Calls that ended before this one began can never be in flight for a later call either.
    for (const lane of candidates) lane.calls = lane.calls.filter((other) => other.ended === undefined || other.ended >= call.began)
    const chosen = call.forced !== undefined ? candidates.find((lane) => lane.name === call.forced) : pickLane(candidates, blocks, call.cacheKey, call.began, this.options.joinOnSharedStart === true)
    const lane = chosen ?? this.open(call.forced, call.session, call.group)
    lane.blocks = blocks
    if (call.cacheKey === undefined) delete lane.cacheKey
    else lane.cacheKey = call.cacheKey
    lane.used = ++this.clock
    return lane
  }

  private open(name: string | undefined, session: string | undefined, group: string | undefined): Lane {
    const count = this.lanes.filter((lane) => lane.session === session && lane.group === group).length
    const base = group ?? "main"
    const lane = { name: name ?? (count === 0 ? base : group ? `${group}:${count + 1}` : `lane-${count + 1}`), ...(session ? { session } : {}), ...(group && !name ? { group } : {}), blocks: [], calls: [], used: 0 }
    this.lanes.push(lane)
    return lane
  }
}

function pickLane(lanes: Lane[], blocks: Block[], cacheKey: string | undefined, began: number, joinOnSharedStart: boolean): Lane | undefined {
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
    // Having no tools is something a request shares with every side query (a title written from the first
    // message): with nothing else in common at the start, only a request that adds a message continues the lane.
    const adds = blocks.filter((block) => block.kind === "message").length > messages
    const related = sameKey && (shared > 0 || (idle && (sameSystem || (sameTools && adds))))
    const score =
      shared === lane.blocks.length && shared > 0
        ? 3e6 + shared
        : messages > 0 && related
          ? 2e6 + messages
          : sameKey && idle && sameTools && sameSystem
            ? 1e6
            : joinOnSharedStart && sameKey && idle && shared > 0
              ? shared
              : -1
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
