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
  /** The id of its latest reply, and the id its latest request continued: a request that names either continues this lane. */
  reply?: string
  continued?: string
  /** Hashes of the messages its conversation produced (replies, tool results) that its requests have held: `carriedOn`. */
  produced: Set<string>
  /** The call that opened it, by sequence number, and the lane whose conversation that call carried on, if it did. */
  first?: number
  follows?: string
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
  /**
   * The reply or conversation id a request names when the provider keeps the conversation (`keptConversation`).
   * Its blocks are only what is new, so they choose no lane: the call joins the lane that id belongs to.
   */
  continues?: string
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
  restore(lane: Omit<Lane, "calls" | "used" | "produced">) {
    const blocks = prefixBlocks(lane.blocks)
    this.lanes.push({ ...lane, blocks, produced: new Set(producedIn(blocks)), calls: [], used: ++this.clock })
  }

  /**
   * Calls that build on each other's prefix belong in one lane; independent
   * conversations through the same proxy (subagents, side queries) need their
   * own, or each would be compared with the other. A call joins:
   * 1. the lane whose latest request is an unchanged prefix of it (the usual case);
   * 2. else the lane it shares the most leading messages with, when it is that conversation going on
   *    and not a side query written from its messages (`goesOn`: an edit, a tool-list change, a mode switch);
   * 3. else an idle lane with the same tools and system prompt (compaction, rewind);
   * 4. else, with `joinOnSharedStart`, an idle lane whose latest request starts with the same block;
   * 5. else a new lane. It `follows` the lane whose conversation the call carries on, if there is one
   *    (`carriedOn`): nothing at the start of the request is the same, so it can read none of that
   *    lane's cache and is rightly not in it, but it is that conversation's next request all the same.
   * Rules 2 to 4 skip a lane whose cache key differs: a harness that names its
   * conversations (Codex sends its thread id as session-id) started another one.
   */
  assign(sent: Block[], call: LaneCall): Lane {
    // Lanes follow the prompt prefix, which deferred tools are not part of.
    const blocks = prefixBlocks(sent)
    const candidates = this.lanes.filter((lane) => lane.session === call.session && (call.forced !== undefined || lane.group === call.group))
    // Calls that ended before this one began can never be in flight for a later call either.
    for (const lane of candidates) lane.calls = lane.calls.filter((other) => other.ended === undefined || other.ended >= call.began)
    const chosen =
      call.forced !== undefined
        ? candidates.find((lane) => lane.name === call.forced)
        : call.continues !== undefined
          ? continuedLane(candidates, call.continues, call.cacheKey)
          : pickLane(candidates, blocks, call.cacheKey, call.began, this.options.joinOnSharedStart === true)
    const lane = chosen ?? this.open(call.forced, call.session, call.group)
    if (!chosen) {
      lane.first = call.began
      const from = call.forced === undefined && call.continues === undefined ? carriedOn(candidates, blocks, call.cacheKey, call.began) : undefined
      if (from) lane.follows = from.name
    }
    for (const hash of producedIn(blocks)) lane.produced.add(hash)
    // A request that continues a conversation the provider keeps leaves the lane's last full request in place:
    // the next request sent in full is matched against that one.
    if (call.continues === undefined) lane.blocks = blocks
    else lane.continued = call.continues
    if (call.cacheKey === undefined) delete lane.cacheKey
    else lane.cacheKey = call.cacheKey
    lane.used = ++this.clock
    return lane
  }

  private open(name: string | undefined, session: string | undefined, group: string | undefined): Lane {
    const count = this.lanes.filter((lane) => lane.session === session && lane.group === group).length
    const base = group ?? "main"
    const lane = { name: name ?? (count === 0 ? base : group ? `${group}:${count + 1}` : `lane-${count + 1}`), ...(session ? { session } : {}), ...(group && !name ? { group } : {}), blocks: [], produced: new Set<string>(), calls: [], used: 0 }
    this.lanes.push(lane)
    return lane
  }
}

/** The lane a request that names `id` continues: the one that id belongs to, else the lane used last (the id came from outside what was recorded). */
function continuedLane(lanes: Lane[], id: string, cacheKey: string | undefined): Lane | undefined {
  const named = lanes.find((lane) => id !== "" && (lane.reply === id || lane.continued === id))
  if (named) return named
  return lanes.filter((lane) => lane.cacheKey === undefined || cacheKey === undefined || lane.cacheKey === cacheKey).sort((a, b) => b.used - a.used)[0]
}

/**
 * How a request relates to a lane's latest request, strongest first. `undefined`: not at all.
 * - `extends`: the latest request is an unchanged prefix of it.
 * - `continues`: it has the lane's leading messages and is that conversation going on (`goesOn`).
 * - `restarts`: no message in common, the same tools and system prompt: a compaction or a rewind.
 * - `shares-start`: the same first block and nothing else. Only for a test of one harness.
 */
type Relation = "extends" | "continues" | "restarts" | "shares-start"

const RANK: Record<Relation, number> = { extends: 3, continues: 2, restarts: 1, "shares-start": 0 }

function pickLane(lanes: Lane[], blocks: Block[], cacheKey: string | undefined, began: number, joinOnSharedStart: boolean): Lane | undefined {
  const sent = parts(blocks)
  const found = lanes.flatMap((lane) => {
    const latest = parts(lane.blocks)
    const shared = sharedPrefix(lane.blocks, blocks)
    const messages = sharedPrefix(latest.messages, sent.messages)
    const sameTools = hashes(latest.tools) === hashes(sent.tools)
    const sameSystem = hashes(latest.system) === hashes(sent.system)
    // A call running alongside the lane's latest one cannot be its next step: that one has not answered yet.
    const idle = lane.calls.every((other) => other.ended !== undefined && other.ended < began)
    // A harness that names its conversations started another one.
    const sameKey = lane.cacheKey === undefined || cacheKey === undefined || lane.cacheKey === cacheKey
    const relation: Relation | undefined =
      shared > 0 && shared === lane.blocks.length
        ? "extends"
        : !sameKey
          ? undefined
          : messages > 0 && (shared > 0 || (idle && goesOn({ sent, messages, sameTools, sameSystem })))
            ? "continues"
            : idle && sameTools && sameSystem
              ? "restarts"
              : joinOnSharedStart && idle && shared > 0
                ? "shares-start"
                : undefined
    // Within a relation, the lane with more in common: leading blocks for an extension or a shared start, leading messages for a continuation.
    return relation === undefined ? [] : [{ lane, rank: RANK[relation], common: relation === "continues" ? messages : shared }]
  })
  return found.sort((a, b) => b.rank - a.rank || b.common - a.common || b.lane.used - a.lane.used)[0]?.lane
}

/**
 * Whether a request that starts with a lane's messages, and shares nothing at the start of the request
 * with it, is that conversation going on. Messages alone do not say so: a side query (a title, a summary)
 * is written from a conversation's messages by other instructions and is no part of it, and a second
 * agent may be handed the same first message. The request goes on with the conversation when:
 * - its instructions are the same; or
 * - its tool list is the same, and it adds a message (with no tools on either side this is all there is
 *   to go by: a title written from the first message adds none).
 * A request with other tools and other instructions is in no lane with it: it can read none of its cache.
 */
function goesOn({ sent, messages, sameTools, sameSystem }: { sent: Parts; messages: number; sameTools: boolean; sameSystem: boolean }): boolean {
  return sameSystem || (sameTools && sent.messages.length > messages)
}

/**
 * The lane whose conversation a request carries on, for a request that is in no lane with it: one that
 * changed its tools and its instructions together, as an agent does whose instructions list its tools.
 * Nothing at the start of such a request is the same, so no lane rule finds it, and yet it is that
 * conversation's next request and re-reads all of it.
 *
 * What says so is a message the conversation itself produced, a reply or the result of a tool it
 * called, held by the request: only a request that comes from that conversation can hold one, where a
 * first user message can be handed to any agent. The request must offer tools, as that conversation's
 * latest request does: one written from a conversation's messages with no tools (a title, a summary)
 * is a side query, not its next step. Of several lanes, the one it holds the most such messages of.
 */
function carriedOn(lanes: Lane[], blocks: Block[], cacheKey: string | undefined, began: number): Lane | undefined {
  if (!blocks.some((block) => block.kind === "tool")) return undefined
  const held = producedIn(blocks)
  if (held.length === 0) return undefined
  const found = lanes.flatMap((lane) => {
    const idle = lane.calls.every((other) => other.ended !== undefined && other.ended < began)
    const sameKey = lane.cacheKey === undefined || cacheKey === undefined || lane.cacheKey === cacheKey
    if (!idle || !sameKey || !lane.blocks.some((block) => block.kind === "tool")) return []
    const common = held.filter((hash) => lane.produced.has(hash)).length
    return common === 0 ? [] : [{ lane, common }]
  })
  return found.sort((a, b) => b.common - a.common || b.lane.used - a.lane.used)[0]?.lane
}

// What a caller writes with no conversation behind it. A block's key is its role, or its item type where it has no role.
const CALLER_ROLES = new Set(["user", "system", "developer"])

/** The hashes of the messages a conversation produced: a model's replies and tool results. A block with no key says nothing either way. */
function producedIn(blocks: Block[]): string[] {
  return blocks.flatMap((block) => (block.kind === "message" && block.key !== undefined && !CALLER_ROLES.has(block.key) ? [block.hash] : []))
}

interface Parts {
  tools: Block[]
  system: Block[]
  messages: Block[]
}

function parts(blocks: Block[]): Parts {
  const of = (kind: Block["kind"]) => blocks.filter((block) => block.kind === kind)
  return { tools: of("tool"), system: of("system"), messages: of("message") }
}

const hashes = (blocks: Block[]) => blocks.map((block) => block.hash).join()

function sharedPrefix(a: Block[], b: Block[]): number {
  let index = 0
  while (index < a.length && index < b.length && a[index]!.hash === b[index]!.hash) index++
  return index
}
