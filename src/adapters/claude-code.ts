// Claude Code session logs: ~/.claude/projects/<project>/<session>.jsonl, with
// subagent logs in <session>/subagents/agent-*.jsonl.
//
// Recent Claude Code versions log the request side of every API call:
//   api-request-shape  { shapeHash, shape: { system, tools } }
//   api-request-blob   { hash, message }            one wire message, by hash
//   api-request        { id, base?, keep, tail[], shapeHash, params, cacheControl[], timestamp, querySource }
// A request's messages are the first `keep` messages of its `base` request
// followed by the messages named in `tail`. Blobs are only written for wire
// messages that differ from the transcript; the rest are found by hashing
// messages rebuilt from transcript records (sha256 of key-sorted JSON).
// Responses are the transcript's `assistant` records, linked by `requestRef`.
//
// What the log does not have: Claude Code's transport adds a first system block
// to every request, a billing-attribution line that changes per session, after
// the request is logged, and sends `params.betas` as the `anthropic-beta`
// header. The logged digest is of the request before that, so it proves the
// tools, the logged system parts, the messages, the params and the breakpoints,
// not the bytes sent. The adapter writes the missing block as an `unknown`
// placeholder in its place (SPEC 4.1), so every other block, and every
// breakpoint, sits where it was sent, and `betas` as the header.
//
// Older logs have no api-request records; for them the adapter falls back to
// usage-only records, one per assistant message id.
//
// Memory. A long session's log is hundreds of megabytes, almost all of it
// message content, and every request repeats the history before it. The log is
// read line by line, once, keeping only what is small (requests, usage, shapes)
// and, for each message, where in the file it is and its hash; content is read
// back from the file when a request needs it. Each request's digest is checked
// by hashing on from the state its base request left at its first breakpoint,
// so a long conversation is hashed about once, not once per request. With
// `contentOnDemand` the records carry message blocks by hash and `content`
// reads them back for the trace writer, so memory grows with the largest
// request, not with the session.

import { createHash, type Hash } from "node:crypto"
import { closeSync, openSync, readSync } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { canonicalizeAnthropic, elideBinary, isRecord } from "../canonical.ts"
import type { Block, Hint, TraceRecord } from "../trace.ts"
import { withoutIdentifiers } from "../params.ts"
import { normalizeUsage } from "../usage.ts"
import type { ImportOptions, ImportResult } from "./index.ts"

type Entry = Record<string, unknown>

export async function importClaudeCode(input: string, options: ImportOptions): Promise<ImportResult> {
  const files = await sessionFiles(input, options.subagents ?? true)
  const warnings: string[] = []
  const store = new MessageStore()
  const records: TraceRecord[] = []
  let costState: Entry | undefined
  // One file at a time: its small parts are read, its records built, and only the records kept.
  for (const [index, file] of files.entries()) {
    const log = await readLog(file.path, store.file(file.path), warnings)
    if (index === 0) costState = log.costState
    records.push(...(log.requests.length > 0 ? fullRecords(log, file.lane, store.file(file.path), options.contentOnDemand === true, warnings) : usageRecords(log, file.lane, warnings)))
  }
  records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  if (costState && (options.subagents ?? true)) warnings.push(...compareCostState(costState, records))
  return { records, warnings, ...(options.contentOnDemand ? { content: (hash: string) => store.content(hash) } : {}) }
}

/**
 * Claude Code keeps its own running token totals per model. When they exceed
 * what the per-call records add up to, some calls (compaction summaries, side
 * queries, failed requests) were billed but not logged call by call.
 */
function compareCostState(state: Entry, records: TraceRecord[]): string[] {
  if (!isRecord(state.modelUsage)) return []
  return Object.entries(state.modelUsage).flatMap(([model, usage]) => {
    if (!isRecord(usage)) return []
    const theirs = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"].reduce((sum, key) => sum + Number(usage[key] ?? 0), 0)
    const ours = records
      .filter((record) => record.model === model)
      .reduce((sum, record) => sum + record.usage.input_tokens + record.usage.cache_read_tokens + (record.usage.cache_write_tokens ?? 0), 0)
    if (theirs - ours <= Math.max(1000, ours * 0.002)) return []
    const cost = typeof usage.costUSD === "number" ? `; Claude Code puts its cost at ${usage.costUSD.toFixed(2)} USD` : ""
    return [
      `Claude Code's own totals for ${model} show ${(theirs - ours).toLocaleString("en-US")} more prompt tokens than the logged calls${cost}. Calls such as compaction summaries or side queries are billed but not logged one by one.`,
    ]
  })
}

async function sessionFiles(input: string, subagents: boolean) {
  const info = await stat(input)
  if (info.isDirectory()) {
    const names = (await readdir(input)).filter((name) => name.endsWith(".jsonl")).sort()
    if (names.length === 0) throw new Error(`no .jsonl files in ${input}`)
    return names.map((name) => ({ path: path.join(input, name), lane: laneName(name) }))
  }
  const main = { path: input, lane: "main" }
  if (!subagents) return [main]
  const dir = path.join(path.dirname(input), path.basename(input, ".jsonl"), "subagents")
  const names = await readdir(dir).catch(() => [] as string[])
  return [
    main,
    ...names
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => ({ path: path.join(dir, name), lane: laneName(name) })),
  ]
}

function laneName(file: string): string {
  return path.basename(file, ".jsonl")
}

// ---------------------------------------------------------------------------------------------
// Reading a log

/** What one log file holds, without its message content (that stays in the file; see MessageStore). */
interface Log {
  requests: Entry[]
  shapes: Map<string, Entry>
  /** One response per API call: the last assistant record carrying its usage (model, usage, timestamp only). */
  responses: Map<string, Entry>
  /** Assistant records with usage, grouped by message id, for logs without api-request records. */
  legacy: Map<string, { first: Entry; last: Entry }>
  boundaries: number[]
  costState?: Entry
}

async function readLog(file: string, store: FileMessages, warnings: string[]): Promise<Log> {
  const log: Log = { requests: [], shapes: new Map(), responses: new Map(), legacy: new Map(), boundaries: [] }
  const transcript = new TranscriptIndex(store)
  let bad = 0
  for await (const line of lines(file)) {
    const entry = parseLine(line.text)
    if (entry === undefined) {
      bad++
      continue
    }
    if (entry === null) continue
    const at = { offset: line.offset, length: line.length }
    if (entry.type === "cost-state") log.costState = entry
    if (entry.type === "api-request-shape" && typeof entry.shapeHash === "string" && isRecord(entry.shape)) log.shapes.set(entry.shapeHash, entry.shape)
    if (entry.type === "api-request-blob" && typeof entry.hash === "string") store.addBlob(entry.hash, entry.message, at)
    if (entry.type === "api-request" && typeof entry.id === "string") log.requests.push(entry)
    if (entry.type === "system" && entry.subtype === "compact_boundary" && typeof entry.timestamp === "string") log.boundaries.push(Date.parse(entry.timestamp))
    if (entry.type === "assistant" && isRecord(entry.message) && isRecord(entry.message.usage) && entry.message.model !== "<synthetic>") {
      const summary = { timestamp: entry.timestamp, sessionId: entry.sessionId, version: entry.version, isSidechain: entry.isSidechain, message: { model: entry.message.model, usage: entry.message.usage } }
      if (typeof entry.requestRef === "string") log.responses.set(entry.requestRef, summary)
      const key = String(entry.message.id ?? entry.requestId ?? entry.uuid)
      const group = log.legacy.get(key)
      if (group) group.last = summary
      else log.legacy.set(key, { first: summary, last: summary })
    }
    transcript.add(entry, at)
  }
  transcript.finish()
  log.boundaries.sort((a, b) => a - b)
  if (bad > 0) warnings.push(`${path.basename(file)}: skipped ${bad} unreadable lines`)
  return log
}

// undefined: not JSON; null: JSON but not an object, or a blank line.
function parseLine(text: string): Entry | null | undefined {
  if (text.trim() === "") return null
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return undefined
  }
}

/** The lines of a file with their byte offsets, read a megabyte at a time. */
async function* lines(file: string): AsyncGenerator<{ text: string; offset: number; length: number }> {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(1 << 20)
    let pending: Buffer[] = []
    let start = 0
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      let from = 0
      for (let newline = buffer.indexOf(10, 0); newline !== -1 && newline < bytesRead; newline = buffer.indexOf(10, from)) {
        const piece = buffer.subarray(from, newline)
        const bytes = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece
        yield { text: bytes.toString("utf8"), offset: start, length: bytes.length }
        pending = []
        start = position + newline + 1
        from = newline + 1
      }
      if (from < bytesRead) pending.push(Buffer.from(buffer.subarray(from, bytesRead)))
      position += bytesRead
    }
    if (pending.length > 0) {
      const bytes = Buffer.concat(pending)
      yield { text: bytes.toString("utf8"), offset: start, length: bytes.length }
    }
  } finally {
    await handle.close()
  }
}

interface Location {
  offset: number
  length: number
}

/**
 * How to rebuild one wire message from the log: which lines hold it and which
 * form it takes (see transcript forms below). A message is found by Claude
 * Code's hash of it, so any source with that hash rebuilds the same message.
 */
type Source =
  | { form: "blob" | "blob-parts" | "message" | "role-content" | "role-parts" | "assistant"; at: Location }
  | { form: "assistant-group" | "user-run"; at: Location[] }

/** Where each message of every log file is, and how to read a block's content back once a request has used it. */
class MessageStore {
  private readonly files = new Map<string, FileMessages>()
  /** Canonical block hash to where its message is. */
  private readonly blocks = new Map<string, { messages: FileMessages; hash: string }>()

  /** The messages of one file. Each file resolves its requests' messages from its own lines only. */
  file(file: string): FileMessages {
    const known = this.files.get(file)
    if (known) return known
    const messages = new FileMessages(file, (block, hash, owner) => this.blocks.set(block, { messages: owner, hash }))
    this.files.set(file, messages)
    return messages
  }

  /** The content of a block some file's records list by hash, read back from its log. */
  content(blockHash: string): unknown {
    const found = this.blocks.get(blockHash)
    return found ? found.messages.block(found.hash).content : undefined
  }
}

/** One file's messages, by Claude Code's hash: where each is, never its content. */
class FileMessages {
  private readonly sources = new Map<string, Source>()
  // The few messages read last: a request's newest messages are read for its digest and again for its block.
  private readonly recent = new Map<string, unknown>()
  readonly path: string
  private readonly onBlock: (blockHash: string, hash: string, owner: FileMessages) => void

  constructor(path: string, onBlock: (blockHash: string, hash: string, owner: FileMessages) => void) {
    this.path = path
    this.onBlock = onBlock
  }

  /** A logged wire message. It wins over a transcript message with the same hash, as the log intends. */
  addBlob(hash: string, message: unknown, at: Location) {
    if (message === undefined) return
    // Some blobs are logged with a string body while the message Claude Code hashed and sent had it as one text part.
    const parts = isRecord(message) && typeof message.content === "string" && ccHash(message) !== hash && ccHash(asParts(message)) === hash
    this.sources.set(hash, { form: parts ? "blob-parts" : "blob", at })
    this.recent.delete(hash)
  }

  /** A message rebuilt from transcript records; never replaces a logged blob. */
  addTranscript(hash: string, source: Source) {
    const known = this.sources.get(hash)
    if (known?.form === "blob" || known?.form === "blob-parts") return
    this.sources.set(hash, source)
  }

  has(hash: string): boolean {
    return this.sources.has(hash)
  }

  /** The message with Claude Code's hash `hash`, read from the log; undefined when no line has it. */
  message(hash: string): unknown {
    if (this.recent.has(hash)) return this.recent.get(hash)
    const source = this.sources.get(hash)
    if (!source) return undefined
    const message = rebuild(this.path, source)
    this.recent.set(hash, message)
    if (this.recent.size > 8) this.recent.delete(this.recent.keys().next().value!)
    return message
  }

  /** The canonical block of a message, without breakpoint, binary data elided. */
  block(hash: string): Block {
    const block = elideBinary(withoutBreakpoint(canonicalizeAnthropic({ messages: [this.message(hash)] }).blocks[0]!))
    this.onBlock(block.hash, hash, this)
    return block
  }
}

function rebuild(file: string, source: Source): unknown {
  const read = (at: Location) => readEntry(file, at)
  if (Array.isArray(source.at)) {
    const content = source.at.flatMap((at) => partsOf((read(at).message as Entry).content))
    return { role: source.form === "user-run" ? "user" : "assistant", content }
  }
  const entry = read(source.at)
  if (source.form === "blob") return entry.message
  if (source.form === "blob-parts") return asParts(entry.message as Entry)
  const message = entry.message as Entry
  if (source.form === "message") return message
  if (source.form === "role-content") return { role: message.role, content: message.content }
  if (source.form === "role-parts") return { role: message.role, content: partsOf(message.content) }
  return { role: "assistant", content: message.content }
}

function readEntry(file: string, at: Location): Entry {
  const buffer = Buffer.alloc(at.length)
  const fd = openSync(file, "r")
  try {
    readSync(fd, buffer, 0, at.length, at.offset)
  } finally {
    closeSync(fd)
  }
  return JSON.parse(buffer.toString("utf8")) as Entry
}

function partsOf(content: unknown): unknown[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []
}

function asParts(message: Entry): Entry {
  return { ...message, content: [{ type: "text", text: message.content }] }
}

/**
 * Indexes the messages rebuilt from the transcript, by Claude Code's message
 * hash. Covers the forms the wire messages take: an assistant turn split
 * across several records, a user string body sent as a text part, and
 * consecutive user records sent as one message. Hashes of the joined forms are
 * built up part by part as their records are read.
 */
class TranscriptIndex {
  private readonly turns = new Map<string, { hash: JoinedHash; at: Location[] }>()
  private run: { hash: JoinedHash; at: Location[] } | undefined
  private readonly store: FileMessages

  constructor(store: FileMessages) {
    this.store = store
  }

  add(entry: Entry, at: Location) {
    if (!isRecord(entry.message)) return
    const message = entry.message
    if (entry.type === "assistant") {
      this.flush()
      const key = typeof entry.requestRef === "string" ? entry.requestRef : String(message.id ?? entry.uuid)
      const turn = this.turns.get(key) ?? { hash: new JoinedHash(), at: [] }
      this.turns.set(key, turn)
      turn.hash.add(partsOf(message.content))
      turn.at.push(at)
      this.store.addTranscript(ccHash({ role: "assistant", content: message.content }), { form: "assistant", at })
    }
    if (entry.type === "user") {
      this.run ??= { hash: new JoinedHash(), at: [] }
      this.run.hash.add(partsOf(message.content))
      this.run.at.push(at)
      this.store.addTranscript(ccHash(message), { form: "message", at })
      this.store.addTranscript(ccHash({ role: message.role, content: message.content }), { form: "role-content", at })
      this.store.addTranscript(ccHash({ role: message.role, content: partsOf(message.content) }), { form: "role-parts", at })
    }
  }

  finish() {
    this.flush()
    for (const turn of this.turns.values()) this.store.addTranscript(turn.hash.digest("assistant"), { form: "assistant-group", at: turn.at })
  }

  private flush() {
    if (this.run && this.run.at.length > 1) this.store.addTranscript(this.run.hash.digest("user"), { form: "user-run", at: this.run.at })
    this.run = undefined
  }
}

/** Claude Code's hash of `{role, content: [...parts]}`, fed one record's parts at a time. */
class JoinedHash {
  private readonly hash = createHash("sha256").update('{"content":[')
  private empty = true

  add(parts: unknown[]) {
    for (const part of parts) {
      this.hash.update(`${this.empty ? "" : ","}${JSON.stringify(sortKeys(part)) ?? "null"}`)
      this.empty = false
    }
  }

  digest(role: string): string {
    return this.hash.copy().update(`],"role":${JSON.stringify(role)}}`).digest("hex")
  }
}

// ---------------------------------------------------------------------------------------------
// Building records

function fullRecords(log: Log, lane: string, store: FileMessages, onDemand: boolean, warnings: string[]): TraceRecord[] {
  const requests = log.requests
  const byId = new Map(requests.map((request) => [request.id as string, request]))
  const memo = new Map<string, string[]>()
  const messageHashes = (id: string, seen = new Set<string>()): string[] => {
    const cached = memo.get(id)
    if (cached) return cached
    const request = byId.get(id)
    if (!request || seen.has(id)) return []
    seen.add(id)
    const keep = typeof request.keep === "number" ? request.keep : 0
    const base = typeof request.base === "string" ? request.base : undefined
    const inherited = base ? messageHashes(base, seen) : []
    // A base that is not in this file still fixes the first `keep` positions; give
    // them stable placeholder identities so later requests compare correctly.
    const prefix = base && inherited.length < keep ? Array.from({ length: keep }, (_, index) => inherited[index] ?? `missing:${base}:${index}`) : inherited.slice(0, keep)
    const hashes = [...prefix, ...(Array.isArray(request.tail) ? request.tail.filter((hash): hash is string => typeof hash === "string") : [])]
    memo.set(id, hashes)
    return hashes
  }
  // Requests share almost all of their blocks, so each shape and message is canonicalized once.
  const shapeMemo = new Map<string, Block[]>()
  const shapeBlocks = (hash: string, shape: Entry | undefined) => {
    const known = shapeMemo.get(hash)
    if (known) return known
    const logged = canonicalizeAnthropic({ tools: shape?.tools, system: shape?.system, messages: [] }).blocks.map(withoutBreakpoint)
    const tools = logged.filter((block) => block.kind === "tool")
    const blocks = [...tools, ATTRIBUTION_BLOCK, ...logged.slice(tools.length)]
    shapeMemo.set(hash, blocks)
    return blocks
  }
  // On demand, message blocks are listed by hash only: their content stays in the log until the trace is written.
  const messageMemo = new Map<string, Block>()
  let unresolved = 0
  const messageBlock = (hash: string): Block => {
    const known = messageMemo.get(hash)
    if (known) return known
    if (!store.has(hash)) unresolved++
    // A message whose content is not in the log is still identified by its hash.
    const block = store.has(hash) ? (onDemand ? withoutContent(store.block(hash)) : store.block(hash)) : { kind: "message" as const, hash: `cc:${hash}` }
    messageMemo.set(hash, block)
    return block
  }
  const digests = new DigestChecker(store)
  const sessionHints = hintsByTime(log.boundaries)
  let missingShape = 0
  let noResponse = 0
  let mismatched = 0
  let unverified = 0
  const records = requests.flatMap((request): TraceRecord[] => {
    const id = request.id as string
    const response = log.responses.get(id)
    if (!response) {
      noResponse++
      return []
    }
    const shape = log.shapes.get(request.shapeHash as string)
    if (!shape) missingShape++
    const hashes = messageHashes(id)
    const params = isRecord(request.params) ? request.params : {}
    const check = shape && hashes.every((hash) => store.has(hash)) ? digests.verify(request, params, shape, hashes) : "unverifiable"
    // A rebuilt request that does not match what Claude Code says it sent would
    // produce wrong diffs; keep its usage but do not claim to know the request.
    if (check === "mismatch") {
      mismatched++
      return [usageRecord(request, response, lane, params, sessionHints)]
    }
    if (check === "unverifiable") unverified++
    const blocks = applyBreakpoints([...shapeBlocks(request.shapeHash as string, shape), ...hashes.map(messageBlock)], request.cacheControl)
    const message = response.message as Entry
    const ts = typeof request.timestamp === "string" ? request.timestamp : (response.timestamp as string)
    const hints = sessionHints(ts)
    return [
      {
        v: 1,
        id,
        ...(typeof request.sessionId === "string" ? { session: request.sessionId } : {}),
        lane: laneOf(request, lane),
        ts,
        provider: "anthropic",
        model: typeof message.model === "string" ? message.model : String(params.model ?? ""),
        params: withoutIdentifiers(canonicalizeAnthropic({ ...withoutBetas(params), messages: [] }).params),
        ...(betasHeader(params) ? { headers: { "anthropic-beta": betasHeader(params)! } } : {}),
        fidelity: "full-request",
        request: { blocks },
        usage: normalizeUsage("anthropic", message.usage),
        cache_ttl_seconds: ttlOf(request.cacheControl),
        ...(hints.length > 0 ? { hints } : {}),
        source: { adapter: "claude-code", ...(typeof request.version === "string" ? { version: request.version } : {}), request: check },
      },
    ]
  })
  if (mismatched > 0)
    warnings.push(
      `${lane}: ${mismatched} requests rebuilt from the log did not match the request digest Claude Code recorded; imported as usage-only`,
    )
  if (unverified > 0)
    warnings.push(`${lane}: ${unverified} requests could not be checked against Claude Code's request digest (content or digest missing)`)
  if (noResponse > 0) warnings.push(`${lane}: ${noResponse} logged requests had no response (errors or interruptions); skipped`)
  if (missingShape > 0) warnings.push(`${lane}: ${missingShape} requests referenced a tools/system shape that is not in the log`)
  if (unresolved > 0)
    warnings.push(`${lane}: ${unresolved} distinct messages could not be resolved to content; they are compared by hash only`)
  return records
}

function withoutContent(block: Block): Block {
  const { content, ...rest } = block
  return rest
}

/**
 * Checks requests against `requestDigest`, the SHA-256 of the key-sorted JSON of
 * the request body Claude Code built ({...params, system, tools, messages} with
 * cache_control set at the logged paths). A match proves the reconstruction is
 * exactly that request.
 *
 * The body is hashed as it would be serialized, key by key and message by
 * message. The hash state just before each marked message of a request is
 * kept, and a request that extends it, with the same leading fields and the
 * same messages and marks up to one of those points, hashes on from there, so
 * the shared history of a long conversation is not hashed again for every
 * request.
 */
class DigestChecker {
  private readonly saved = new Map<string, { lead: string; hashes: string[]; points: { count: number; marks: string; state: Hash }[] }>()
  // The serialized fields after the messages (system, tools, the later params) for the last few shapes and marks.
  private readonly tails = new Map<string, string | typeof MISMATCH>()
  private readonly store: FileMessages

  constructor(store: FileMessages) {
    this.store = store
  }

  verify(request: Entry, params: Entry, shape: Entry, hashes: string[]): "verified" | "mismatch" | "unverifiable" {
    if (typeof request.requestDigest !== "string") return "unverifiable"
    const marks = Array.isArray(request.cacheControl) ? request.cacheControl : []
    if (marks.some((mark) => !isRecord(mark) || !Array.isArray(mark.path) || mark.path.length === 0)) return "unverifiable"
    const body: Entry = { ...params, system: shape.system, tools: shape.tools, messages: hashes }
    const keys = Object.keys(body)
      .filter((key) => body[key] !== undefined)
      .sort()
    const paths = marks as { path: unknown[]; value?: unknown }[]
    // A mark on a field the body does not have, or on a message it does not have, cannot have been set.
    if (paths.some((mark) => !keys.includes(String(mark.path[0])))) return "mismatch"
    const messageMarks = paths.filter((mark) => mark.path[0] === "messages")
    if (messageMarks.some((mark) => mark.path.length > 1 && !(Number.isInteger(mark.path[1]) && (mark.path[1] as number) >= 0 && (mark.path[1] as number) < hashes.length))) return "mismatch"
    const fields = (list: string[]) => {
      const texts = list.map((key) => {
        const value = withMarks(body[key], paths.filter((mark) => mark.path[0] === key), 1)
        return value === MISMATCH ? MISMATCH : `${JSON.stringify(key)}:${JSON.stringify(sortKeys(value))}`
      })
      return texts.includes(MISMATCH) ? MISMATCH : texts.join(",")
    }
    const split = keys.indexOf("messages")
    const before = fields(keys.slice(0, split))
    const afterKeys = keys.slice(split + 1)
    const tailKey = `${String(request.shapeHash)}\u0000${JSON.stringify(afterKeys.map((key) => (key === "system" || key === "tools" ? key : [key, body[key]])))}\u0000${JSON.stringify(paths.filter((mark) => mark.path[0] !== "messages"))}`
    const after = this.tails.get(tailKey) ?? fields(afterKeys)
    this.tails.set(tailKey, after)
    if (this.tails.size > 16) this.tails.delete(this.tails.keys().next().value!)
    if (before === MISMATCH || after === MISMATCH) return "mismatch"
    const lead = `{${before}${split > 0 ? "," : ""}"messages":[`
    // The marks on messages before `count`, which the serialization up to there depends on.
    const marksBefore = (count: number) => JSON.stringify(messageMarks.filter((mark) => typeof mark.path[1] !== "number" || mark.path[1] < count))
    const base = typeof request.base === "string" ? this.saved.get(request.base) : undefined
    const resume =
      base && base.lead === lead
        ? base.points.find((point) => point.count <= hashes.length && point.marks === marksBefore(point.count) && base.hashes.slice(0, point.count).every((hash, index) => hashes[index] === hash))
        : undefined
    const state = resume ? resume.state.copy() : createHash("sha256").update(lead)
    const points: { count: number; marks: string; state: Hash }[] = []
    for (let index = resume ? resume.count : 0; index < hashes.length; index++) {
      const at = messageMarks.filter((mark) => mark.path[1] === index)
      if (at.length > 0) points.unshift({ count: index, marks: marksBefore(index), state: state.copy() })
      const message = withMarks(this.store.message(hashes[index]!), at, 2)
      if (message === MISMATCH) return "mismatch"
      state.update(`${index === 0 ? "" : ","}${JSON.stringify(sortKeys(message))}`)
    }
    // Latest first: the longest shared history is tried first.
    this.saved.set(request.id as string, { lead, hashes, points: [...points, ...(resume ? [resume] : [])] })
    // A request almost always extends one of the last few; older states are let go so memory does not grow with the session.
    if (this.saved.size > 64) this.saved.delete(this.saved.keys().next().value!)
    state.update(`]${afterKeys.length > 0 ? `,${after}` : ""}}`)
    return state.digest("hex") === request.requestDigest ? "verified" : "mismatch"
  }
}

const MISMATCH = Symbol("mismatch")

/** `value` with cache_control set at each mark's path below `depth`, copying only the nodes along the paths; MISMATCH when a path does not exist. */
function withMarks(value: unknown, marks: { path: unknown[]; value?: unknown }[], depth: number): unknown {
  if (marks.length === 0) return value
  let root: unknown = value
  for (const mark of marks) {
    if (!isRecord(root) && !Array.isArray(root)) return MISMATCH
    root = Array.isArray(root) ? [...root] : { ...(root as Entry) }
    let node = root as Entry
    for (const key of mark.path.slice(depth)) {
      const child: unknown = node[key as string]
      if (!isRecord(child) && !Array.isArray(child)) return MISMATCH
      const copy: unknown[] | Entry = Array.isArray(child) ? [...child] : { ...child }
      node[key as string] = copy
      node = copy as Entry
    }
    node.cache_control = (mark as Entry).value
  }
  return root
}

/** A call whose request could not be trusted: its usage alone. */
function usageRecord(request: Entry, response: Entry, lane: string, params: Entry, hints: (ts: string) => Hint[]): TraceRecord {
  const message = response.message as Entry
  const ts = typeof request.timestamp === "string" ? request.timestamp : (response.timestamp as string)
  const found = hints(ts)
  return {
    v: 1,
    id: request.id as string,
    ...(typeof request.sessionId === "string" ? { session: request.sessionId } : {}),
    lane: laneOf(request, lane),
    ts,
    provider: "anthropic",
    model: typeof message.model === "string" ? message.model : String(params.model ?? ""),
    fidelity: "usage-only",
    usage: normalizeUsage("anthropic", message.usage),
    ...(ttlOf(request.cacheControl) ? { cache_ttl_seconds: ttlOf(request.cacheControl) } : {}),
    ...(found.length > 0 ? { hints: found } : {}),
    source: { adapter: "claude-code", ...(typeof request.version === "string" ? { version: request.version } : {}), request: "mismatch" },
  }
}

// Side queries in the main file (compaction, titles) get their own lane.
function laneOf(request: Entry, lane: string): string {
  return lane === "main" && typeof request.querySource === "string" && request.querySource !== "sdk" && request.querySource !== "repl_main_thread"
    ? request.querySource
    : lane
}

/** Claude Code's message hash: SHA-256 of JSON with keys sorted at every depth. */
function ccHash(message: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(message))).digest("hex")
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  )
}

/**
 * The system block Claude Code sends first and does not log: its billing-attribution line. Its
 * content and real hash are unknown, so it is a placeholder that stays the same across calls.
 */
const ATTRIBUTION_BLOCK: Block = { kind: "system", key: "billing-attribution", hash: "unknown:claude-code-billing-attribution", unknown: true }

// Claude Code logs the beta flags with the params; it sends them as the anthropic-beta header.
function withoutBetas(params: Entry): Entry {
  const { betas, ...rest } = params
  return rest
}

function betasHeader(params: Entry): string | undefined {
  return Array.isArray(params.betas) && params.betas.length > 0 && params.betas.every((beta) => typeof beta === "string") ? params.betas.join(",") : undefined
}

/**
 * Applies the logged cache_control positions as breakpoints. The paths are into the request as
 * logged, whose system prompt lacks the attribution block, so system positions start after it.
 */
function applyBreakpoints(blocks: Block[], cacheControl: unknown): Block[] {
  const toolCount = blocks.filter((block) => block.kind === "tool").length + blocks.filter((block) => block.unknown).length
  const headCount = blocks.filter((block) => block.kind !== "message").length
  const marked = new Set<number>()
  for (const mark of Array.isArray(cacheControl) ? cacheControl : []) {
    if (!isRecord(mark) || !Array.isArray(mark.path) || typeof mark.path[1] !== "number") continue
    const [area, index] = mark.path as [unknown, number]
    if (area === "tools") marked.add(index)
    if (area === "system") marked.add(toolCount + index)
    if (area === "messages") marked.add(headCount + index)
  }
  // Blocks are shared between requests, so only the marked ones are copied.
  for (const index of marked) if (blocks[index]) blocks[index] = { ...blocks[index]!, breakpoint: true }
  return blocks
}

function withoutBreakpoint(block: Block): Block {
  if (block.breakpoint === undefined) return block
  const { breakpoint, ...rest } = block
  return rest
}

// The TTL that governs the conversation prefix is the one on the last breakpoint.
function ttlOf(cacheControl: unknown): number | undefined {
  const marks = Array.isArray(cacheControl) ? cacheControl.filter(isRecord) : []
  const last = marks.at(-1)
  if (!last || !isRecord(last.value)) return undefined
  return last.value.ttl === "1h" ? 3600 : 300
}

/** Compaction boundaries in the transcript, attached to the first call after each. */
function hintsByTime(boundaries: number[]): (ts: string) => Hint[] {
  let previous = Number.NEGATIVE_INFINITY
  return (ts) => {
    const now = Date.parse(ts)
    const hit = boundaries.some((time) => time > previous && time <= now)
    previous = now
    return hit ? [{ kind: "compaction", detail: "compact boundary in transcript" }] : []
  }
}

/** Fallback for logs without request records: one usage-only record per assistant message. */
function usageRecords(log: Log, lane: string, warnings: string[]): TraceRecord[] {
  const sessionHints = hintsByTime(log.boundaries)
  if (log.legacy.size === 0) warnings.push(`${lane}: no assistant responses with usage found`)
  // The request's breakpoints are not logged, but the usage says which TTL its
  // cache writes used; carry the last one seen forward per lane.
  const ttls = new Map<string, number>()
  return [...log.legacy.entries()].map(([id, group]): TraceRecord => {
    const first = group.first
    const message = group.last.message as Entry
    const ts = String(first.timestamp)
    const hints = sessionHints(ts)
    // Old logs kept sidechains inline in the main file; subagent files are already their own lane.
    const recordLane = first.isSidechain === true && lane === "main" ? "sidechain" : lane
    const creation = isRecord(message.usage) && isRecord(message.usage.cache_creation) ? message.usage.cache_creation : {}
    const oneHour = Number(creation.ephemeral_1h_input_tokens ?? 0)
    const fiveMinute = Number(creation.ephemeral_5m_input_tokens ?? 0)
    if (oneHour > 0 || fiveMinute > 0) ttls.set(recordLane, oneHour >= fiveMinute ? 3600 : 300)
    const ttl = ttls.get(recordLane)
    return {
      v: 1,
      id,
      ...(typeof first.sessionId === "string" ? { session: first.sessionId } : {}),
      lane: recordLane,
      ts,
      provider: "anthropic",
      model: String(message.model ?? ""),
      fidelity: "usage-only",
      usage: normalizeUsage("anthropic", message.usage),
      ...(ttl ? { cache_ttl_seconds: ttl } : {}),
      ...(hints.length > 0 ? { hints } : {}),
      source: { adapter: "claude-code", ...(typeof first.version === "string" ? { version: first.version } : {}) },
    }
  })
}
