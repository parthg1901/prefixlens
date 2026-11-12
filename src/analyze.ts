// Turns a trace into per-call results: hit rate, cost, whether the call missed
// a cache it should have hit, and why.

import { coveringBreaks, declaredBreaks, describePosition, keptBlocks, type DeclaredBreak } from "./breaks.ts"
import { CAUSE_GROUP, comparePrefix, type Cause, type CauseGroup, type PrefixChange, type Region } from "./diff.ts"
import { resolvePrice, type CatalogueTable, type PriceSources, type Resolution } from "./catalogue.ts"
import { costOf, DEFAULT_STALE_AFTER_DAYS, pricedDays, pricingAge, providerFacts, ratesFor, uncachedRate, type Cost, type PricingTable } from "./pricing.ts"
import { laneKey, type Block, type Fidelity, type TraceRecord, type Usage } from "./trace.ts"
import { promptTokens } from "./usage.ts"

export type Status = "cold" | "hit" | "partial" | "miss" | "uncached"
export type Confidence = "confirmed" | "inferred" | "unknown"

export interface CauseInfo {
  cause: Cause
  group: CauseGroup
  summary: string
  /** confirmed: proven from full requests. inferred: from usage, timing or harness hints. unknown: no evidence. */
  confidence: Confidence
  region?: Region
  block_index?: number
  detail?: Record<string, unknown>
  diff?: string
}

export interface TurnResult {
  /** 1-based position of the call in the trace. */
  turn: number
  id?: string
  session?: string
  lane: string
  ts: string
  provider: string
  model: string
  fidelity: Fidelity
  usage: Usage
  prompt_tokens: number
  /** cache_read_tokens / prompt_tokens. */
  hit_rate: number
  /** Tokens the previous call in the same lane left in the cache, capped at this call's prompt. */
  expected_cached_tokens: number
  /** expected_cached_tokens not read from cache on this call. */
  lost_tokens: number
  status: Status
  cost: Cost | null
  /** Cost of uncached input and cache writes. */
  uncached_cost: number | null
  /** What lost_tokens cost above the cache-read price. */
  miss_cost: number | null
  /** table: the pricing table; catalogue: the models.dev overlay (see the report's notes); reported: the harness's own figure. */
  priced: "table" | "catalogue" | "reported" | "none"
  /** Turn number of the previous call in the same lane, the baseline for comparison. */
  baseline_turn?: number
  gap_seconds?: number
  cause?: CauseInfo
  /** Set when the prefix changed without losing tokens (the change came after the cached part). */
  prefix_change?: CauseInfo
  /** On a miss or partial miss: the breaks the harness declared on this call (SPEC 6.1), and whether they excuse it. */
  declared_break?: DeclaredBreakResult
  /** The response was cut off before it ended (SPEC 2, `interrupted`): input-side counts are final, output tokens and cost are lower bounds. */
  interrupted?: true
}

export interface DeclaredBreakResult {
  /** The declared reasons, e.g. ["compaction"]. */
  reasons: string[]
  declarations: DeclaredBreak[]
  /** True when the miss is excused: reported as an intentional break, counted apart from misses. */
  intentional: boolean
  /** True when two full requests showed the change starts where a declaration allows it; false for usage-only comparisons. */
  checked: boolean
  /** Why the declaration does not excuse this miss, or what could not be checked. */
  note?: string
}

export interface GroupTotal {
  group: CauseGroup
  misses: number
  cost: number
}

export interface ReasonTotal {
  reason: string
  breaks: number
  cost: number
}

export interface Summary {
  turns: number
  lanes: string[]
  fidelity: { full_request: number; usage_only: number }
  tokens: { prompt: number; input: number; cache_read: number; cache_write: number; output: number }
  hit_rate: number
  /** `misses`: what avoidable misses cost; `intentional`: what declared intentional breaks cost. */
  cost: { total: number; uncached: number; misses: number; intentional: number } | null
  reported_cost?: number
  status: Record<Status, number>
  /** Calls that lost cached tokens (misses plus partial misses), not counting declared intentional breaks. */
  misses: number
  /** Avoidable misses by cause group. */
  by_group: GroupTotal[]
  /** Calls that lost cached tokens because of a break the harness declared (SPEC 6.1). Counted apart from `misses`. */
  intentional: { breaks: number; by_reason: ReasonTotal[] }
  headline: string
  unpriced_models: string[]
  notes: string[]
  /** Turns whose response was cut off before it ended; their output tokens, and so the totals of output and cost, are lower bounds. */
  interrupted: number[]
}

export interface Analysis {
  version: 1
  summary: Summary
  turns: TurnResult[]
  warnings: string[]
}

export interface AnalyzeOptions {
  pricing: PricingTable
  /** The models.dev overlay, for models the pricing table does not list. */
  catalogue?: CatalogueTable
  /** Trace provider to models.dev provider, for opting in to a router's or cloud's prices (default: anthropic, openai, gemini to their own). */
  catalogueProviders?: Record<string, string>
  /** Lost tokens at or below this count are treated as a hit. Default 128 (OpenAI caches in 128-token steps). */
  toleranceTokens?: number
  /** The date the pricing table's age is measured against. Default: now. */
  now?: Date
}

export function analyze(records: TraceRecord[], options: AnalyzeOptions): Analysis {
  const tolerance = options.toleranceTokens ?? 128
  const warnings: string[] = []
  const last = new Map<string, number>()
  const sources: PriceSources = { table: options.pricing, ...(options.catalogue ? { catalogue: options.catalogue } : {}), ...(options.catalogueProviders ? { catalogueProviders: options.catalogueProviders } : {}) }
  const prices: PriceLog = new Map()
  const turns = records.map((record, index): TurnResult => {
    const lane = laneKey(record)
    const previousIndex = last.get(lane)
    last.set(lane, index)
    return analyzeTurn(records, index, previousIndex, sources, prices, tolerance, warnings)
  })
  return { version: 1, summary: summarize(turns, records, sources, prices, options.now ?? new Date()), turns, warnings }
}

function analyzeTurn(
  records: TraceRecord[],
  index: number,
  previousIndex: number | undefined,
  sources: PriceSources,
  prices: PriceLog,
  tolerance: number,
  warnings: string[],
): TurnResult {
  const record = records[index]!
  const previous = previousIndex === undefined ? undefined : records[previousIndex]
  const prompt = promptTokens(record.usage)
  const resolution = resolvePrice(sources, record.provider, record.model, record.usage, { ts: record.ts, ...(record.params ? { params: record.params } : {}) })
  logPrice(prices, record, resolution)
  const price = resolution.source === "none" ? undefined : resolution.entry
  const facts = providerFacts(sources.table, record.provider, price)
  const rates = price ? ratesFor(price, prompt) : undefined
  const cost = rates ? costOf(record.usage, rates) : null
  const base = {
    turn: index + 1,
    ...(record.id ? { id: record.id } : {}),
    ...(record.session ? { session: record.session } : {}),
    lane: record.lane ?? "main",
    ts: record.ts,
    provider: record.provider,
    model: record.model,
    fidelity: record.fidelity,
    usage: record.usage,
    prompt_tokens: prompt,
    hit_rate: prompt === 0 ? 0 : record.usage.cache_read_tokens / prompt,
    cost,
    uncached_cost: cost ? cost.input + cost.cache_write : null,
    ...(record.interrupted ? { interrupted: true as const } : {}),
    priced: cost ? resolution.source === "catalogue" ? ("catalogue" as const) : ("table" as const) : record.usage.reported_cost !== undefined ? ("reported" as const) : ("none" as const),
  }
  if (!previous)
    return {
      ...base,
      expected_cached_tokens: 0,
      lost_tokens: 0,
      status: "cold",
      miss_cost: cost ? 0 : null,
      cause: { cause: "cold_start", group: CAUSE_GROUP.cold_start, summary: "first call in this lane: nothing cached yet", confidence: "confirmed" },
    }

  const gap = (Date.parse(record.ts) - Date.parse(previous.ts)) / 1000
  if (gap < 0) warnings.push(`turn ${index + 1}: timestamp is earlier than the previous call in its lane`)
  const expected = Math.min(prompt, expectedCached(previous, facts.min_cacheable_tokens))
  const lost = Math.max(0, expected - record.usage.cache_read_tokens)
  const status: Status =
    expected < facts.min_cacheable_tokens && record.usage.cache_read_tokens === 0
      ? "uncached"
      : lost <= tolerance
        ? "hit"
        : record.usage.cache_read_tokens <= tolerance
          ? "miss"
          : "partial"
  const missCost = rates && lost > 0 && (status === "miss" || status === "partial") ? (lost * Math.max(0, uncachedRate(record.usage, rates) - rates.cache_read)) / 1e6 : rates ? 0 : null
  const full = record.fidelity === "full-request" && previous.fidelity === "full-request" && record.request && previous.request
  const change = full
    ? comparePrefix(
        { provider: previous.provider, model: previous.model, params: previous.params, blocks: previous.request!.blocks },
        { provider: record.provider, model: record.model, params: record.params, blocks: record.request!.blocks, hints: record.hints },
      )
    : null
  const ttl = previous.cache_ttl_seconds ?? facts.cache_ttl_seconds
  const turn = {
    ...base,
    expected_cached_tokens: expected,
    lost_tokens: lost,
    status,
    miss_cost: missCost,
    baseline_turn: previousIndex! + 1,
    gap_seconds: gap,
  }
  if (status === "miss" || status === "partial") {
    const declared = declaredBreaks(record.hints)
    const withDeclared = (result: TurnResult, verdict: Omit<DeclaredBreakResult, "reasons" | "declarations"> | undefined): TurnResult =>
      declared.length === 0 || !verdict ? result : { ...result, declared_break: { reasons: [...new Set(declared.map((entry) => entry.reason))], declarations: declared, ...verdict } }
    if (!full)
      return withDeclared(
        { ...turn, cause: inferredCause(previous, record, gap, ttl, declared) },
        { intentional: true, checked: false, note: "usage-only: where the prefix changed cannot be checked against the declaration" },
      )
    // With explicit caching the previous call cached only up to its last breakpoint, so a change after it cannot explain the loss.
    const lastBreakpoint = explicitCaching(previous) ? previous.request!.blocks.findLastIndex((block) => block.breakpoint) : -1
    const afterCached = change?.block_index !== undefined && lastBreakpoint !== -1 && change.block_index > lastBreakpoint
    const cause = confirmedCause(afterCached ? null : change, gap, ttl, previous.usage.cache_write_tokens ?? 0, [previous.headers?.["session-id"], record.headers?.["session-id"]])
    const verdict = judgeDeclared(declared, afterCached ? null : change, previous.request!.blocks)
    if (!afterCached) return withDeclared({ ...turn, cause }, verdict)
    const where = `cached prefix unchanged (the first change, at block ${change!.block_index! + 1}, is after the previous call's last cache breakpoint)`
    return withDeclared({ ...turn, cause: { ...cause, summary: cause.summary.replace(/^prefix unchanged/, where) }, prefix_change: fromChange(change!, "confirmed") }, verdict)
  }
  return change ? { ...turn, prefix_change: fromChange(change, "confirmed") } : turn
}

/**
 * What the previous call left in the cache. With explicit caching (Anthropic)
 * that is what it read plus what it wrote: nothing is cached without a
 * breakpoint, and a reported zero means nothing was written. With implicit
 * caching (OpenAI, Gemini) the provider caches the whole prompt once it is
 * long enough, whatever write figure it reports: a reported zero (the ChatGPT
 * sign-in backend always reports one) does not mean the uncached part of the
 * prompt was left out of the cache, so it never lowers the expectation; a real
 * write count can only raise it.
 */
function expectedCached(previous: TraceRecord, minimum: number): number {
  const usage = previous.usage
  const measured = usage.cache_read_tokens + (usage.cache_write_tokens ?? 0)
  if (explicitCaching(previous)) return measured
  const prompt = promptTokens(usage)
  // Implicit caches hold whole 128-token steps; the partial step at the end is never read back.
  return Math.max(measured, prompt >= minimum ? Math.floor(prompt / IMPLICIT_STEP_TOKENS) * IMPLICIT_STEP_TOKENS : 0)
}

/** Providers that cache prompt prefixes automatically. Their write figures are billing facts, not a measure of what was cached. */
const IMPLICIT_CACHING = new Set(["openai", "gemini"])

/** Explicit caching: a known explicit-caching provider (Anthropic), or any other provider that reports writes. */
function explicitCaching(record: TraceRecord): boolean {
  return record.usage.cache_write_tokens !== null && !IMPLICIT_CACHING.has(record.provider)
}

const IMPLICIT_STEP_TOKENS = 128

// A request sent this soon after the call that wrote the cache can miss with
// nothing changed: the new entry is not always readable yet.
const FRESH_WRITE_SECONDS = 5

/**
 * Whether the breaks a call declares excuse its miss, given the first change
 * two full requests show. A declaration excuses only a change that starts
 * after the part it says must survive; with the prefix intact the miss was not
 * caused by the break, so it is not excused either.
 */
function judgeDeclared(declared: DeclaredBreak[], change: PrefixChange | null, prev: Block[]): Omit<DeclaredBreakResult, "reasons" | "declarations"> | undefined {
  if (declared.length === 0) return undefined
  const named = declared.map((entry) => entry.reason).join(", ")
  if (!change) return { intentional: false, checked: true, note: `a break was declared (${named}), but the cached prefix was intact, so the break does not explain this miss` }
  if (coveringBreaks(declared, change, prev).length > 0) return { intentional: true, checked: true }
  const widest = declared.toSorted((a, b) => keptBlocks(a.after, prev) - keptBlocks(b.after, prev))[0]!
  return {
    intentional: false,
    checked: true,
    note: `a break was declared (${named}) that must keep ${describePosition(widest.after)} unchanged, but the first change is earlier (${change.region === "params" || change.region === "model" ? `the ${change.region === "model" ? "model" : "request parameters"}` : `block ${change.block_index! + 1}, in the ${change.region}`})`,
  }
}

function confirmedCause(change: PrefixChange | null, gap: number, ttl: number, previousWrite: number, sessionIds: (string | undefined)[]): CauseInfo {
  if (change) return fromChange(change, "confirmed")
  // OpenAI's ChatGPT sign-in flow routes requests to a cache by this header.
  const [before, after] = sessionIds
  if (before !== undefined && after !== undefined && before !== after)
    return {
      cause: "params_changed",
      group: CAUSE_GROUP.params_changed,
      summary: `prefix unchanged, but the session-id header changed (${before} → ${after}); the provider routes requests to a cache by it`,
      confidence: "confirmed",
      detail: { header: "session-id", from: before, to: after },
    }
  if (gap > ttl)
    return {
      cause: "cache_expired",
      group: CAUSE_GROUP.cache_expired,
      summary: `prefix unchanged, cache expired: ${duration(gap)} since the previous call (TTL ${duration(ttl)})`,
      confidence: "confirmed",
      detail: { gap_seconds: gap, ttl_seconds: ttl },
    }
  const fresh = previousWrite > 0 && gap <= FRESH_WRITE_SECONDS
  return {
    cause: "provider_side",
    group: CAUSE_GROUP.provider_side,
    summary: fresh
      ? `prefix unchanged, provider-side miss: sent ${duration(gap)} after the call that wrote the cache, which may not have been readable yet; not caused by the harness`
      : `prefix unchanged and within TTL (${duration(gap)} < ${duration(ttl)}): provider-side miss, not caused by the harness`,
    confidence: "confirmed",
    detail: { gap_seconds: gap, ttl_seconds: ttl, ...(fresh ? { fresh_write: true } : {}) },
  }
}

const USAGE_ONLY = "usage-only trace: root-cause diffs need full requests"
const UNCONFIRMED = "unconfirmed (usage-only)"

// The cause a declared reason stands for when only usage is known.
const REASON_CAUSE: Record<string, Cause> = {
  compaction: "compaction",
  revert: "history_rewound",
  refusal: "message_removed",
  model_switch: "model_changed",
  settings_change: "params_changed",
}

function inferredCause(previous: TraceRecord, record: TraceRecord, gap: number, ttl: number, declared: DeclaredBreak[]): CauseInfo {
  const inferred = (cause: Cause, summary: string, detail?: Record<string, unknown>): CauseInfo => ({
    cause,
    group: CAUSE_GROUP[cause],
    summary,
    confidence: cause === "model_changed" ? "confirmed" : "inferred",
    ...(detail ? { detail } : {}),
  })
  if (previous.model !== record.model)
    return inferred("model_changed", `model changed (${previous.model} → ${record.model}); caches are per model`, {
      from: previous.model,
      to: record.model,
    })
  const hint = (kind: string) => record.hints?.find((candidate) => candidate.kind === kind)
  const stated = declared.find((entry) => entry.kind === "prefix_break")
  if (stated)
    return inferred(
      REASON_CAUSE[stated.reason] ?? "unknown",
      `the harness declared an intentional break (${stated.reason}${stated.detail ? `: ${stated.detail}` : ""}); ${UNCONFIRMED}`,
    )
  const compaction = hint("compaction")
  if (compaction)
    return inferred("compaction", `history compacted before this call (harness log${compaction.detail ? `: ${compaction.detail}` : ""}); ${UNCONFIRMED}`)
  const agent = hint("agent_switch")
  if (agent)
    return inferred("tools_changed", `agent switched (${agent.detail ?? "different agent"}); its tool list and system prompt usually differ; ${UNCONFIRMED}`)
  const pruned = hint("tool_output_pruned")
  if (pruned)
    return inferred("tool_output_rewritten", `the harness pruned earlier tool outputs before this call${pruned.detail ? ` (${pruned.detail})` : ""}; ${UNCONFIRMED}`)
  if (gap > ttl)
    return inferred("cache_expired", `likely cache expiry: ${duration(gap)} since the previous call (TTL ${duration(ttl)}); ${UNCONFIRMED}`, {
      gap_seconds: gap,
      ttl_seconds: ttl,
    })
  return { cause: "unknown", group: CAUSE_GROUP.unknown, summary: `cause unknown: ${USAGE_ONLY}`, confidence: "unknown" }
}

function fromChange(change: PrefixChange, confidence: Confidence): CauseInfo {
  return {
    cause: change.cause,
    group: CAUSE_GROUP[change.cause],
    summary: change.summary,
    confidence,
    region: change.region,
    ...(change.block_index === undefined ? {} : { block_index: change.block_index }),
    detail: change.detail,
    ...(change.diff ? { diff: change.diff } : {}),
  }
}

function summarize(turns: TurnResult[], records: TraceRecord[], sources: PriceSources, prices: PriceLog, now: Date): Summary {
  const pricing = sources.table
  const sum = (pick: (turn: TurnResult) => number) => turns.reduce((total, turn) => total + pick(turn), 0)
  const tokens = {
    prompt: sum((turn) => turn.prompt_tokens),
    input: sum((turn) => turn.usage.input_tokens),
    cache_read: sum((turn) => turn.usage.cache_read_tokens),
    cache_write: sum((turn) => turn.usage.cache_write_tokens ?? 0),
    output: sum((turn) => turn.usage.output_tokens),
  }
  const lostTokens = turns.filter((turn) => turn.status === "miss" || turn.status === "partial")
  const intentional = lostTokens.filter((turn) => turn.declared_break?.intentional)
  const missed = lostTokens.filter((turn) => !turn.declared_break?.intentional)
  const priced = turns.every((turn) => turn.cost !== null)
  const total = (list: TurnResult[]) => list.reduce((value, turn) => value + (turn.miss_cost ?? 0), 0)
  const cost = priced
    ? { total: sum((turn) => turn.cost!.total), uncached: sum((turn) => turn.uncached_cost ?? 0), misses: total(missed), intentional: total(intentional) }
    : null
  const reported = records.some((record) => record.usage.reported_cost !== undefined)
    ? records.reduce((total, record) => total + (record.usage.reported_cost ?? 0), 0)
    : undefined
  const groups = new Map<CauseGroup, GroupTotal>()
  for (const turn of missed) {
    const group = turn.cause?.group ?? "unknown causes"
    const entry = groups.get(group) ?? { group, misses: 0, cost: 0 }
    entry.misses++
    entry.cost += turn.miss_cost ?? 0
    groups.set(group, entry)
  }
  const byGroup = [...groups.values()].sort((a, b) => b.misses - a.misses || b.cost - a.cost)
  const reasons = new Map<string, ReasonTotal>()
  for (const turn of intentional) {
    const reason = turn.declared_break!.reasons.join(", ")
    const entry = reasons.get(reason) ?? { reason, breaks: 0, cost: 0 }
    entry.breaks++
    entry.cost += turn.miss_cost ?? 0
    reasons.set(reason, entry)
  }
  const byReason = [...reasons.values()].sort((a, b) => b.breaks - a.breaks || b.cost - a.cost)
  const status = { cold: 0, hit: 0, partial: 0, miss: 0, uncached: 0 }
  for (const turn of turns) status[turn.status]++
  const usageOnly = turns.filter((turn) => turn.fidelity === "usage-only").length
  const unpriced = [...new Set(turns.filter((turn) => turn.cost === null).map((turn) => turn.model))]
  const cutOff = turns.filter((turn) => turn.interrupted).map((turn) => turn.turn)
  const notes = [
    ...(cutOff.length > 0
      ? [
          `${cutOff.length === 1 ? `Call ${cutOff[0]} was` : `Calls ${cutOff.join(", ")} were`} cut off before the response ended (the client disconnected): ${cutOff.length === 1 ? "its" : "their"} input and cache counts are final, so hit rates and misses are exact, but output tokens and cost are lower bounds.`,
        ]
      : []),
    ...(usageOnly > 0
      ? [
          `${usageOnly} of ${turns.length} calls are usage-only: hit rates and costs are exact, but root-cause diffs need full requests (causes shown are inferred from timing and harness hints).`,
        ]
      : []),
    ...(unpriced.length > 0 ? [`No price for ${unpricedList(turns, pricing, prices)}: add it to the pricing table to get costs.`] : []),
    ...sourceNotes(sources, prices, now),
    ...(status.uncached > 0
      ? [`${status.uncached} calls had nothing cacheable from the call before (no cache writes, or a prefix below the minimum cacheable size).`]
      : []),
    ...(turns.some((turn) => turn.cost !== null) ? pricingNotes(pricing, now) : []),
  ]
  return {
    turns: turns.length,
    lanes: [...new Set(turns.map((turn) => turn.lane))],
    fidelity: { full_request: turns.length - usageOnly, usage_only: usageOnly },
    tokens,
    hit_rate: tokens.prompt === 0 ? 0 : tokens.cache_read / tokens.prompt,
    cost,
    ...(reported === undefined ? {} : { reported_cost: reported }),
    status,
    misses: missed.length,
    by_group: byGroup,
    intentional: { breaks: intentional.length, by_reason: byReason },
    headline: headline(missed.length, cost?.misses ?? null, byGroup, byReason, cost?.intentional ?? null),
    unpriced_models: unpriced,
    interrupted: cutOff,
    notes,
  }
}

function headline(misses: number, cost: number | null, groups: GroupTotal[], reasons: ReasonTotal[], intentionalCost: number | null): string {
  const breaks = reasons.reduce((count, reason) => count + reason.breaks, 0)
  const declared =
    breaks === 0
      ? ""
      : `${breaks} intentional ${breaks === 1 ? "break" : "breaks"} declared by the harness${intentionalCost === null ? "" : ` cost ${money(intentionalCost)} at list prices`} (${reasons.map((reason) => `${reason.breaks} ${reason.reason}`).join(", ")})`
  if (misses === 0)
    return breaks === 0 ? "No cache misses after the first call in each lane." : `No unexpected cache misses after the first call in each lane; ${declared}.`
  const costText = cost === null ? "" : ` cost ${money(cost)} at list prices`
  const parts = groups.map((group) => (group.group === "unknown causes" ? `${group.misses} with no known cause` : `${group.misses} from ${group.group}`))
  return `${misses} ${misses === 1 ? "miss" : "misses"}${costText}; ${parts.join(", ")}${breaks === 0 ? "" : `. Also ${declared}.`}`
}

// "gpt-5.6-sol on 2026-12-03 (priced until 2026-11-30)" when the table prices the model, only not on the calls' days.
function unpricedList(turns: TurnResult[], pricing: PricingTable, prices: PriceLog): string {
  const groups = new Map<string, TurnResult[]>()
  for (const turn of turns.filter((turn) => turn.cost === null)) groups.set(turn.model, [...(groups.get(turn.model) ?? []), turn])
  return [...groups.entries()]
    .map(([model, list]) => {
      const periods = pricedDays(pricing, list[0]!.provider, model)
      const reason = catalogueGap(prices.get(`${list[0]!.provider}\0${model}`))
      if (reason) return `${model} (${reason})`
      if (periods.length === 0) return model
      const days = [...new Set(list.map((turn) => turn.ts.slice(0, 10)))].sort()
      const when = days.length === 1 ? days[0] : `${days[0]} to ${days.at(-1)}`
      const priced = periods.map((period) => (period.from && period.until ? `${period.from} to ${period.until}` : period.from ? `from ${period.from}` : `until ${period.until}`))
      return `${model} on ${when} (priced ${priced.join(" and ")})`
    })
    .join(", ")
}

// One entry per provider and model: how its calls were priced, and which catalogue fields its unpriced calls lacked.
interface LoggedPrice {
  provider: string
  model: string
  resolutions: Resolution[]
  missing: Set<string>
}
type PriceLog = Map<string, LoggedPrice>

function logPrice(prices: PriceLog, record: TraceRecord, resolution: Resolution) {
  if (resolution.source === "table" && !resolution.differences) return
  const key = `${record.provider}\0${record.model}`
  const entry = prices.get(key) ?? { provider: record.provider, model: record.model, resolutions: [], missing: new Set<string>() }
  if (!entry.resolutions.some((seen) => seen.source === resolution.source && JSON.stringify(seen) === JSON.stringify(resolution))) entry.resolutions.push(resolution)
  if (resolution.source === "none") for (const field of resolution.missing ?? []) entry.missing.add(field)
  prices.set(key, entry)
}

const MISSING_FIELD: Record<string, string> = {
  input: "input price",
  output: "output price",
  cache_read: "cache-read price",
  cache_write: "cache-write price",
  cache_write_1h: "1-hour cache-write price",
  reasoning: "way to apply its separate reasoning-token price",
}

// Why a model the catalogue has is still unpriced: a price the calls need is not listed, or the id is ambiguous.
function catalogueGap(logged: LoggedPrice | undefined): string | undefined {
  if (!logged) return undefined
  if (logged.missing.size > 0) {
    const catalogue = logged.resolutions.find((resolution) => resolution.source === "none" && resolution.catalogue)
    const id = catalogue?.source === "none" && catalogue.catalogue ? `${catalogue.catalogue.provider} ${catalogue.catalogue.id}` : logged.model
    const fields = [...logged.missing].map((field) => MISSING_FIELD[field] ?? `price for its ${field.replace(/_mode$/, "")} mode`)
    return `models.dev lists ${id} with no ${fields.join(" or ")}, which these calls need; they are not costed rather than priced at a guess`
  }
  const alias = logged.resolutions.find((resolution) => resolution.source === "none" && resolution.alias)
  if (alias?.source === "none" && alias.alias)
    return `models.dev ${alias.alias.provider} ${alias.alias.id} is an alias the provider repoints at other models, so its catalogue price is not used`
  const ambiguous = logged.resolutions.find((resolution) => resolution.source === "none" && resolution.ambiguous)
  if (ambiguous?.source === "none" && ambiguous.ambiguous)
    return `models.dev ${ambiguous.ambiguous[0]!.provider} lists ${ambiguous.ambiguous.map((entry) => entry.id).join(", ")} at different prices; use the full model id`
  return undefined
}

// Which prices came from the catalogue, and where the table and the catalogue disagree.
function sourceNotes(sources: PriceSources, prices: PriceLog, now: Date): string[] {
  const catalogue = sources.catalogue
  if (!catalogue) return []
  const fetched = catalogue.fetched_at.slice(0, 10)
  const logged = [...prices.values()]
  const fromCatalogue = logged.flatMap((entry) => entry.resolutions.filter((resolution) => resolution.source === "catalogue").map((resolution) => ({ entry, resolution })))
  const used = [...new Map(fromCatalogue.map((item) => [`${item.entry.model}\0${item.resolution.catalogue.provider}\0${item.resolution.catalogue.id}\0${item.resolution.mode ?? ""}`, item])).values()]
  const catalogueNote =
    used.length === 0
      ? []
      : [
          `Priced from the models.dev catalogue (fetched ${fetched}), not the hand-verified pricing table: ${used
            .map(({ entry, resolution }) => {
              const facts = providerFacts(sources.table, entry.provider)
              return `${entry.model} as models.dev ${resolution.catalogue.provider} ${resolution.catalogue.id}${resolution.mode ? ` (${resolution.mode} mode)` : ""}${resolution.catalogue.last_updated ? `, last updated ${resolution.catalogue.last_updated}` : ""}; cache lifetime ${facts.cache_ttl_seconds} s and minimum ${facts.min_cacheable_tokens.toLocaleString("en-US")} tokens are ${entry.provider} defaults`
            })
            .join("; ")}. models.dev is community-maintained; check a price with prefixlens pricing show <model>.`,
        ]
  const age = Math.floor((now.getTime() - Date.parse(catalogue.fetched_at)) / 86_400_000)
  const limit = sources.table.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS
  const staleNote = used.length > 0 && age > limit ? [`The models.dev prices were fetched ${age} days ago (${fetched}): run prefixlens pricing update.`] : []
  const disagreements = logged.flatMap((entry) =>
    entry.resolutions.flatMap((resolution) => {
      if (resolution.source !== "table" || !resolution.differences || !resolution.compared) return []
      const checked = sources.table.sources?.[resolution.entry.provider ?? entry.provider]?.checked ?? sources.table.as_of
      const compared = resolution.compared
      const fields = resolution.differences
        .map((difference) => `${difference.field.replaceAll("_", " ")} ${difference.table === undefined ? "none" : dollars(difference.table)} vs ${difference.catalogue === undefined ? "none" : dollars(difference.catalogue)}`)
        .join(", ")
      return [
        `Prices differ for ${entry.model}: the pricing table${checked ? ` (checked ${checked})` : ""} vs models.dev ${compared.provider} ${compared.id}${compared.last_updated ? ` (last updated ${compared.last_updated}, fetched ${fetched})` : ` (fetched ${fetched})`}: ${fields} per million tokens. The pricing table's figures are used; check the provider's pricing page.`,
      ]
    }),
  )
  return [...catalogueNote, ...staleNote, ...[...new Set(disagreements)]]
}

function dollars(value: number): string {
  return `$${Number(value.toFixed(6))}`
}

function pricingNotes(pricing: PricingTable, now: Date): string[] {
  const age = pricingAge(pricing, now)
  const limit = pricing.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS
  return [
    "Costs are at API list prices: what these calls would cost billed per token, not what was paid. Calls on a subscription (a Claude plan, ChatGPT sign-in, Codex) are not billed per token, and discounts, batch and priority tiers are not applied.",
    ...(age === undefined
      ? ["The pricing table has no as_of date, so how current its prices are is unknown."]
      : age > limit
        ? [`The pricing table is ${age} days old (as of ${pricing.as_of}) and prices change: update it or pass a current one with --pricing (see Pricing in the README).`]
        : []),
  ]
}

export function money(value: number): string {
  if (value === 0) return "$0.00"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    const rest = Math.round(seconds - minutes * 60)
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds - hours * 3600) / 60)
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}
