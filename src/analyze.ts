// Turns a trace into per-call results: hit rate, cost, whether the call missed
// a cache it should have hit, and why.

import { CAUSE_GROUP, comparePrefix, type Cause, type CauseGroup, type PrefixChange, type Region } from "./diff.ts"
import { costOf, findPrice, providerFacts, ratesFor, uncachedRate, type Cost, type PricingTable } from "./pricing.ts"
import type { Fidelity, TraceRecord, Usage } from "./trace.ts"
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
  priced: "table" | "reported" | "none"
  /** Turn number of the previous call in the same lane, the baseline for comparison. */
  baseline_turn?: number
  gap_seconds?: number
  cause?: CauseInfo
  /** Set when the prefix changed without losing tokens (the change came after the cached part). */
  prefix_change?: CauseInfo
}

export interface GroupTotal {
  group: CauseGroup
  misses: number
  cost: number
}

export interface Summary {
  turns: number
  lanes: string[]
  fidelity: { full_request: number; usage_only: number }
  tokens: { prompt: number; input: number; cache_read: number; cache_write: number; output: number }
  hit_rate: number
  cost: { total: number; uncached: number; misses: number } | null
  reported_cost?: number
  status: Record<Status, number>
  /** Calls that lost cached tokens: misses plus partial misses. */
  misses: number
  by_group: GroupTotal[]
  headline: string
  unpriced_models: string[]
  notes: string[]
}

export interface Analysis {
  version: 1
  summary: Summary
  turns: TurnResult[]
  warnings: string[]
}

export interface AnalyzeOptions {
  pricing: PricingTable
  /** Lost tokens at or below this count are treated as a hit. Default 128 (OpenAI caches in 128-token steps). */
  toleranceTokens?: number
}

export function analyze(records: TraceRecord[], options: AnalyzeOptions): Analysis {
  const tolerance = options.toleranceTokens ?? 128
  const warnings: string[] = []
  const last = new Map<string, number>()
  const turns = records.map((record, index): TurnResult => {
    const lane = laneOf(record)
    const previousIndex = last.get(lane)
    last.set(lane, index)
    return analyzeTurn(records, index, previousIndex, options.pricing, tolerance, warnings)
  })
  return { version: 1, summary: summarize(turns, records), turns, warnings }
}

function laneOf(record: TraceRecord): string {
  return [record.session ?? "", record.lane ?? ""].filter(Boolean).join("/") || "main"
}

function analyzeTurn(
  records: TraceRecord[],
  index: number,
  previousIndex: number | undefined,
  pricing: PricingTable,
  tolerance: number,
  warnings: string[],
): TurnResult {
  const record = records[index]!
  const previous = previousIndex === undefined ? undefined : records[previousIndex]
  const prompt = promptTokens(record.usage)
  const facts = providerFacts(pricing, record.provider)
  const price = findPrice(pricing, record.provider, record.model)
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
    priced: cost ? ("table" as const) : record.usage.reported_cost !== undefined ? ("reported" as const) : ("none" as const),
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
  const expected = Math.min(prompt, expectedCached(previous.usage, facts.min_cacheable_tokens))
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
        { model: previous.model, params: previous.params, blocks: previous.request!.blocks },
        { model: record.model, params: record.params, blocks: record.request!.blocks, hints: record.hints },
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
    const cause = full ? confirmedCause(change, gap, ttl) : inferredCause(previous, record, gap, ttl)
    return { ...turn, cause }
  }
  return change ? { ...turn, prefix_change: fromChange(change, "confirmed") } : turn
}

/**
 * What the previous call left in the cache. With explicit caching (Anthropic)
 * that is what it read plus what it wrote. With implicit caching (no write
 * figure) the provider caches the whole prompt once it is long enough.
 */
function expectedCached(previous: Usage, minimum: number): number {
  if (previous.cache_write_tokens !== null) return previous.cache_read_tokens + previous.cache_write_tokens
  const prompt = promptTokens(previous)
  return prompt >= minimum ? prompt : 0
}

function confirmedCause(change: PrefixChange | null, gap: number, ttl: number): CauseInfo {
  if (change) return fromChange(change, "confirmed")
  if (gap > ttl)
    return {
      cause: "cache_expired",
      group: CAUSE_GROUP.cache_expired,
      summary: `prefix unchanged, cache expired: ${duration(gap)} since the previous call (TTL ${duration(ttl)})`,
      confidence: "confirmed",
      detail: { gap_seconds: gap, ttl_seconds: ttl },
    }
  return {
    cause: "provider_side",
    group: CAUSE_GROUP.provider_side,
    summary: `prefix unchanged and within TTL (${duration(gap)} < ${duration(ttl)}): provider-side miss`,
    confidence: "confirmed",
    detail: { gap_seconds: gap, ttl_seconds: ttl },
  }
}

const USAGE_ONLY = "usage-only trace: root-cause diffs need full requests"
const UNCONFIRMED = "unconfirmed (usage-only)"

function inferredCause(previous: TraceRecord, record: TraceRecord, gap: number, ttl: number): CauseInfo {
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

function summarize(turns: TurnResult[], records: TraceRecord[]): Summary {
  const sum = (pick: (turn: TurnResult) => number) => turns.reduce((total, turn) => total + pick(turn), 0)
  const tokens = {
    prompt: sum((turn) => turn.prompt_tokens),
    input: sum((turn) => turn.usage.input_tokens),
    cache_read: sum((turn) => turn.usage.cache_read_tokens),
    cache_write: sum((turn) => turn.usage.cache_write_tokens ?? 0),
    output: sum((turn) => turn.usage.output_tokens),
  }
  const priced = turns.every((turn) => turn.cost !== null)
  const cost = priced
    ? { total: sum((turn) => turn.cost!.total), uncached: sum((turn) => turn.uncached_cost ?? 0), misses: sum((turn) => turn.miss_cost ?? 0) }
    : null
  const reported = records.some((record) => record.usage.reported_cost !== undefined)
    ? records.reduce((total, record) => total + (record.usage.reported_cost ?? 0), 0)
    : undefined
  const missed = turns.filter((turn) => turn.status === "miss" || turn.status === "partial")
  const groups = new Map<CauseGroup, GroupTotal>()
  for (const turn of missed) {
    const group = turn.cause?.group ?? "unknown causes"
    const entry = groups.get(group) ?? { group, misses: 0, cost: 0 }
    entry.misses++
    entry.cost += turn.miss_cost ?? 0
    groups.set(group, entry)
  }
  const byGroup = [...groups.values()].sort((a, b) => b.misses - a.misses || b.cost - a.cost)
  const status = { cold: 0, hit: 0, partial: 0, miss: 0, uncached: 0 }
  for (const turn of turns) status[turn.status]++
  const usageOnly = turns.filter((turn) => turn.fidelity === "usage-only").length
  const unpriced = [...new Set(turns.filter((turn) => turn.cost === null).map((turn) => turn.model))]
  const notes = [
    ...(usageOnly > 0
      ? [
          `${usageOnly} of ${turns.length} calls are usage-only: hit rates and costs are exact, but root-cause diffs need full requests (causes shown are inferred from timing and harness hints).`,
        ]
      : []),
    ...(unpriced.length > 0 ? [`No price for ${unpriced.join(", ")}: add it to the pricing table to get costs.`] : []),
    ...(status.uncached > 0
      ? [`${status.uncached} calls had nothing cacheable from the call before (no cache writes, or a prefix below the minimum cacheable size).`]
      : []),
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
    headline: headline(missed.length, cost?.misses ?? null, byGroup),
    unpriced_models: unpriced,
    notes,
  }
}

function headline(misses: number, cost: number | null, groups: GroupTotal[]): string {
  if (misses === 0) return "No cache misses after the first call in each lane."
  const costText = cost === null ? "" : ` cost ${money(cost)}`
  const parts = groups.map((group) => (group.group === "unknown causes" ? `${group.misses} with no known cause` : `${group.misses} from ${group.group}`))
  return `${misses} ${misses === 1 ? "miss" : "misses"}${costText}; ${parts.join(", ")}`
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
