// Loads the user-editable pricing table and prices a call's usage with it.
// No price lives in code: everything comes from the JSON table.

import { isRecord } from "./canonical.ts"
import type { Usage } from "./trace.ts"
import { promptTokens } from "./usage.ts"

export interface Rates {
  input: number
  output: number
  cache_read: number
  cache_write?: number
  cache_write_1h?: number
}

export interface PriceEntry extends Rates {
  provider?: string
  match: string | string[]
  tiers?: (Partial<Rates> & { above_prompt_tokens: number })[]
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
  providers?: Record<string, ProviderFacts>
  models: PriceEntry[]
}

export const DEFAULT_PRICING_URL = new URL("../pricing.json", import.meta.url)

export async function loadPricing(path?: string): Promise<PricingTable> {
  const source = path ?? process.env.PREFIXLENS_PRICING
  const file = source ? Bun.file(source) : Bun.file(DEFAULT_PRICING_URL)
  if (!(await file.exists())) throw new Error(`pricing table not found: ${source ?? DEFAULT_PRICING_URL.pathname}`)
  return parsePricing(await file.json())
}

/** Validates a pricing table at the boundary so pricing code can trust its shape. */
export function parsePricing(value: unknown): PricingTable {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error("pricing table must be an object with a models array")
  if (value.unit !== undefined && value.unit !== "per_million_tokens") throw new Error('pricing unit must be "per_million_tokens"')
  value.models.forEach((entry, index) => {
    if (!isRecord(entry)) throw new Error(`pricing models[${index}] must be an object`)
    const patterns = Array.isArray(entry.match) ? entry.match : [entry.match]
    if (patterns.length === 0 || !patterns.every((pattern) => typeof pattern === "string"))
      throw new Error(`pricing models[${index}].match must be a string or an array of strings`)
    for (const field of ["input", "output", "cache_read"])
      if (!isRate(entry[field])) throw new Error(`pricing models[${index}].${field} must be a non-negative number`)
    for (const field of ["cache_write", "cache_write_1h"])
      if (entry[field] !== undefined && !isRate(entry[field]))
        throw new Error(`pricing models[${index}].${field} must be a non-negative number`)
  })
  return { version: 1, currency: "USD", unit: "per_million_tokens", ...(value as object) } as PricingTable
}

/** Lowercase, drop any `provider/` prefix, and read `.` as `-` so `anthropic/claude-sonnet-4.5` matches `claude-sonnet-4-5*`. */
export function normalizeModelId(model: string): string {
  const id = (model.toLowerCase().split("/").pop() ?? "").replace(/^((us|eu|apac|global)\.)?anthropic\./, "")
  return id.replaceAll(".", "-")
}

export function findPrice(table: PricingTable, provider: string, model: string): PriceEntry | undefined {
  const id = normalizeModelId(model)
  const strict = knownProvider(table, provider)
  const providerMatches = (entry: PriceEntry) => !strict || entry.provider === undefined || entry.provider === provider
  return table.models.find(
    (entry) => providerMatches(entry) && (Array.isArray(entry.match) ? entry.match : [entry.match]).some((pattern) => glob(pattern).test(id)),
  )
}

// Harness provider ids such as "openrouter" or "github-copilot" are not in the
// providers table; for those, any entry whose pattern matches the model applies.
function knownProvider(table: PricingTable, provider: string): boolean {
  return table.models.some((entry) => entry.provider === provider)
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

export function providerFacts(table: PricingTable, provider: string): Required<ProviderFacts> {
  const facts = { ...(table.providers?.default ?? {}), ...(table.providers?.[provider] ?? {}) }
  return { cache_ttl_seconds: facts.cache_ttl_seconds ?? 300, min_cacheable_tokens: facts.min_cacheable_tokens ?? 1024 }
}

export { promptTokens }

function glob(pattern: string): RegExp {
  const escaped = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  return new RegExp(`^${escaped}$`)
}

function isRate(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
