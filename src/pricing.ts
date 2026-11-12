// Loads the user-editable pricing table and prices a call's usage with it.
// No price lives in code: everything comes from the JSON table.

import { isRecord } from "./canonical.ts"
import type { Usage } from "./trace.ts"
import { promptTokens } from "./usage.ts"

export interface Rates {
  input: number
  output: number
  cache_read: number
  /** Write price for the provider's default cache lifetime (Anthropic 5 minutes, OpenAI 30 minutes). */
  cache_write?: number
  /** Anthropic's 1-hour-lifetime write price. */
  cache_write_1h?: number
  /** OpenAI's 12-hour-lifetime write price. Recorded for reference: traces cannot yet say which writes used it (see README "Pricing"). */
  cache_write_12h?: number
}

export interface PriceEntry extends Rates {
  provider?: string
  /** Exact model ids this price is for: the provider's name, its documented aliases and dated snapshots. */
  names?: string[]
  /** Glob patterns, for hand-written tables. Tried only after no entry lists the exact id in `names`. */
  match?: string | string[]
  /** First and last UTC day (YYYY-MM-DD, inclusive) a call is billed at this price, for prices that change on a set date. */
  from?: string
  until?: string
  /** Request parameters that select this price, e.g. `{"speed": "fast"}` for Anthropic fast mode. */
  when_params?: Record<string, unknown>
  tiers?: (Partial<Rates> & { above_prompt_tokens: number })[]
  /** Model-specific cache facts, overriding the provider's. */
  cache_ttl_seconds?: number
  min_cacheable_tokens?: number
}

export interface ProviderFacts {
  cache_ttl_seconds?: number
  min_cacheable_tokens?: number
}

export interface PricingTable {
  version: 1
  currency: string
  unit: "per_million_tokens"
  as_of?: string
  /** A report notes the table's age once it is older than this many days. Default 60. */
  stale_after_days?: number
  providers?: Record<string, ProviderFacts>
  /** Where each provider's prices came from and the day they were checked. */
  sources?: Record<string, { checked?: string; urls?: string[]; notes?: string[] }>
  models: PriceEntry[]
}

/** What about a call, besides its model, selects a price: the day it was sent and its request parameters. */
export interface PriceContext {
  ts?: string
  params?: Record<string, unknown>
}

export const DEFAULT_PRICING_URL = new URL("../pricing.json", import.meta.url)
export const DEFAULT_STALE_AFTER_DAYS = 60

export async function loadPricing(path?: string): Promise<PricingTable> {
  const source = path || process.env.PREFIXLENS_PRICING
  const file = source ? Bun.file(source) : Bun.file(DEFAULT_PRICING_URL)
  const name = source || DEFAULT_PRICING_URL.pathname
  if (!(await file.exists())) throw new Error(`pricing table not found: ${name}`)
  const value = await file.json().catch(() => {
    throw new Error(`pricing table ${name} is not valid JSON`)
  })
  return parsePricing(value)
}

/** Validates a pricing table at the boundary so pricing code can trust its shape. */
export function parsePricing(value: unknown): PricingTable {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error("pricing table must be an object with a models array")
  if (value.unit !== undefined && value.unit !== "per_million_tokens") throw new Error('pricing unit must be "per_million_tokens"')
  if (value.as_of !== undefined && !isDay(value.as_of)) throw new Error("pricing as_of must be a YYYY-MM-DD date")
  value.models.forEach((entry, index) => checkEntry(entry, `pricing models[${index}]`))
  const table = { version: 1, currency: "USD", unit: "per_million_tokens", ...(value as object) } as PricingTable
  checkDuplicates(table)
  return table
}

/**
 * The trace's model id in the form table names are compared in: lowercase; without a router or
 * API path prefix (`openai/`, `openrouter/anthropic/`, `models/`); without a Bedrock region and
 * vendor prefix (`global.anthropic.`, `openai.`) or version suffix (`-v1:0`); with Vertex's
 * `@` date separator and every `.` read as `-`, so `anthropic/claude-sonnet-4.5` and
 * `claude-sonnet-4-5` are the same id.
 */
export function normalizeModelId(model: string): string {
  return (model.trim().toLowerCase().split("/").pop() ?? "")
    .replace(/^(global|us|eu|apac|jp|au)\./, "")
    .replace(/^(anthropic|openai|google)\./, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replaceAll("@", "-")
    .replaceAll(".", "-")
}

/**
 * The price for a call. An entry that lists the exact (normalized) id wins; among those, one whose
 * `when_params` match the call's parameters beats one without. Glob `match` patterns are tried only
 * when no entry names the id. Entries outside their `from`/`until` days never apply.
 */
export function findPrice(table: PricingTable, provider: string, model: string, context: PriceContext = {}): PriceEntry | undefined {
  const id = normalizeModelId(model)
  const strict = table.models.some((entry) => entry.provider === provider)
  const applies = (entry: PriceEntry) =>
    (!strict || entry.provider === undefined || entry.provider === provider) && inEffect(entry, context.ts) && paramsMatch(entry, context.params)
  const named = table.models.filter((entry) => applies(entry) && (entry.names ?? []).some((name) => normalizeModelId(name) === id))
  return (
    named.find((entry) => entry.when_params !== undefined) ??
    named[0] ??
    table.models.find((entry) => applies(entry) && patterns(entry).some((pattern) => glob(normalizeModelId(pattern)).test(id)))
  )
}

/** True when the table lists `model` for `provider` at all, on any day or with any parameters, by the same rules as findPrice. */
export function listsModel(table: PricingTable, provider: string, model: string): boolean {
  const id = normalizeModelId(model)
  const strict = table.models.some((entry) => entry.provider === provider)
  return table.models.some(
    (entry) =>
      (!strict || entry.provider === undefined || entry.provider === provider) &&
      ((entry.names ?? []).some((name) => normalizeModelId(name) === id) || patterns(entry).some((pattern) => glob(normalizeModelId(pattern)).test(id))),
  )
}

/** Days a model has a listed price, for explaining why a call on another day has none. */
export function pricedDays(table: PricingTable, provider: string, model: string): { from?: string; until?: string }[] {
  const id = normalizeModelId(model)
  return table.models
    .filter((entry) => (entry.provider === undefined || entry.provider === provider) && entry.when_params === undefined)
    .filter((entry) => (entry.names ?? []).some((name) => normalizeModelId(name) === id))
    .map((entry) => ({ ...(entry.from ? { from: entry.from } : {}), ...(entry.until ? { until: entry.until } : {}) }))
}

export function ratesFor(entry: PriceEntry, prompt: number): Rates {
  const tier = (entry.tiers ?? [])
    .filter((candidate) => prompt > candidate.above_prompt_tokens)
    .sort((a, b) => b.above_prompt_tokens - a.above_prompt_tokens)[0]
  return { ...entry, ...(tier ?? {}) }
}

export interface Cost {
  total: number
  input: number
  cache_read: number
  cache_write: number
  output: number
}

export function costOf(usage: Usage, rates: Rates): Cost {
  const write = usage.cache_write_tokens ?? 0
  const oneHour = Math.min(write, usage.cache_write_1h_tokens ?? 0)
  const writeRate = rates.cache_write ?? rates.input
  const cost = {
    input: (usage.input_tokens * rates.input) / 1e6,
    cache_read: (usage.cache_read_tokens * rates.cache_read) / 1e6,
    cache_write: ((write - oneHour) * writeRate + oneHour * (rates.cache_write_1h ?? writeRate)) / 1e6,
    output: (usage.output_tokens * rates.output) / 1e6,
  }
  return { ...cost, total: cost.input + cost.cache_read + cost.cache_write + cost.output }
}

/** Average price per token actually paid for the input that was not read from cache. */
export function uncachedRate(usage: Usage, rates: Rates): number {
  const write = usage.cache_write_tokens ?? 0
  const tokens = usage.input_tokens + write
  if (tokens === 0) return rates.input
  const cost = costOf(usage, rates)
  return ((cost.input + cost.cache_write) * 1e6) / tokens
}

/** Cache facts for a call: the model's own, else its provider's, else the table default. */
export function providerFacts(table: PricingTable, provider: string, entry?: PriceEntry): Required<ProviderFacts> {
  const facts = { ...(table.providers?.default ?? {}), ...(table.providers?.[provider] ?? {}) }
  return {
    cache_ttl_seconds: entry?.cache_ttl_seconds ?? facts.cache_ttl_seconds ?? 300,
    min_cacheable_tokens: entry?.min_cacheable_tokens ?? facts.min_cacheable_tokens ?? 1024,
  }
}

/** Whole days from the table's as_of date to `now`, or undefined when the table has no date. */
export function pricingAge(table: PricingTable, now: Date): number | undefined {
  if (!table.as_of) return undefined
  return Math.floor((now.getTime() - Date.parse(`${table.as_of}T00:00:00Z`)) / 86_400_000)
}

export { promptTokens }

function inEffect(entry: PriceEntry, ts: string | undefined): boolean {
  if (!entry.from && !entry.until) return true
  // A dated price needs the call's date; without one, only undated entries apply.
  const day = ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString().slice(0, 10) : undefined
  if (!day) return false
  return (!entry.from || day >= entry.from) && (!entry.until || day <= entry.until)
}

function paramsMatch(entry: PriceEntry, params: Record<string, unknown> | undefined): boolean {
  if (!entry.when_params) return true
  return Object.entries(entry.when_params).every(([key, value]) => params?.[key] === value)
}

function patterns(entry: PriceEntry): string[] {
  return entry.match === undefined ? [] : Array.isArray(entry.match) ? entry.match : [entry.match]
}

function checkEntry(entry: unknown, at: string) {
  if (!isRecord(entry)) throw new Error(`${at} must be an object`)
  const names = entry.names
  if (names !== undefined && (!Array.isArray(names) || names.length === 0 || !names.every((name) => typeof name === "string" && name.length > 0)))
    throw new Error(`${at}.names must be a non-empty array of model ids`)
  if (entry.match !== undefined) {
    const list = Array.isArray(entry.match) ? entry.match : [entry.match]
    if (list.length === 0 || !list.every((pattern) => typeof pattern === "string")) throw new Error(`${at}.match must be a string or an array of strings`)
  }
  if (names === undefined && entry.match === undefined) throw new Error(`${at} needs names (exact model ids) or match (glob patterns)`)
  checkRates(entry, at, true)
  for (const field of ["from", "until"])
    if (entry[field] !== undefined && !isDay(entry[field])) throw new Error(`${at}.${field} must be a YYYY-MM-DD date`)
  if (typeof entry.from === "string" && typeof entry.until === "string" && entry.from > entry.until) throw new Error(`${at}.from is after its until`)
  if (entry.when_params !== undefined && (!isRecord(entry.when_params) || Object.keys(entry.when_params).length === 0))
    throw new Error(`${at}.when_params must be an object of request parameters`)
  for (const field of ["cache_ttl_seconds", "min_cacheable_tokens"])
    if (entry[field] !== undefined && !(isRate(entry[field]) && (entry[field] as number) > 0)) throw new Error(`${at}.${field} must be a positive number`)
  if (entry.tiers !== undefined) {
    if (!Array.isArray(entry.tiers)) throw new Error(`${at}.tiers must be an array`)
    entry.tiers.forEach((tier, index) => {
      if (!isRecord(tier) || !isRate(tier.above_prompt_tokens)) throw new Error(`${at}.tiers[${index}].above_prompt_tokens must be a non-negative number`)
      checkRates(tier, `${at}.tiers[${index}]`, false)
    })
  }
}

function checkRates(value: Record<string, unknown>, at: string, required: boolean) {
  for (const field of ["input", "output", "cache_read"])
    if ((required || value[field] !== undefined) && !isRate(value[field])) throw new Error(`${at}.${field} must be a non-negative number`)
  for (const field of ["cache_write", "cache_write_1h", "cache_write_12h"])
    if (value[field] !== undefined && !isRate(value[field])) throw new Error(`${at}.${field} must be a non-negative number`)
}

// Two entries that name the same id for the same provider, parameters and days would make the
// price depend on table order, so a table that does this is rejected.
function checkDuplicates(table: PricingTable) {
  const seen: { id: string; index: number; entry: PriceEntry }[] = []
  table.models.forEach((entry, index) => {
    for (const id of new Set((entry.names ?? []).map(normalizeModelId))) {
      const clash = seen.find((other) => other.id === id && overlaps(other.entry, entry))
      if (clash) throw new Error(`pricing: ${id} is listed in models[${clash.index}] and models[${index}] for the same provider, parameters and days`)
      seen.push({ id, index, entry })
    }
  })
}

function overlaps(a: PriceEntry, b: PriceEntry): boolean {
  if (a.provider !== undefined && b.provider !== undefined && a.provider !== b.provider) return false
  if (JSON.stringify(a.when_params ?? null) !== JSON.stringify(b.when_params ?? null)) return false
  return (a.from ?? "0000-00-00") <= (b.until ?? "9999-99-99") && (b.from ?? "0000-00-00") <= (a.until ?? "9999-99-99")
}

function glob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  return new RegExp(`^${escaped}$`)
}

function isRate(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isDay(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}
