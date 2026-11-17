// How big a prefix break in a test is, and what it costs when the model has a price.
//
// A request in a test has no provider usage, so the size is an estimate from the request content,
// by the rule the test session's stand-in usage uses (estimate.ts). The tokens counted are the ones
// the trace path calls lost (SPEC 8): what the previous request left in the cache from the first
// changed block on, capped at what the new request sends from there. The price is the trace path's
// miss cost for those tokens, from the pricing table, at list prices, for this one call.
//
// Synchronous and offline: the bundled table is a file next to the package, read once on the first
// priced break. Any problem reading it leaves the break unpriced; it never throws into a test.

import { readFileSync } from "node:fs"
import { isItemReference } from "./canonical.ts"
import { resolvePrice } from "./catalogue.ts"
import { tokensFromChars } from "./estimate.ts"
import { DEFAULT_PRICING_URL, parsePricing, ratesFor, uncachedRate, type PricingTable } from "./pricing.ts"
import type { Block } from "./trace.ts"

/** The estimated size of a prefix break, and its price when the model has one. */
export interface BreakSize {
  /**
   * Estimated tokens the previous request left in the cache, from the first changed block on, that this
   * request sends again and cannot read from the cache: the part from the change on, capped at what this
   * request sends from there (a shorter request after a compaction re-reads no more than it sends).
   */
  reread: number
  /** Estimated tokens before the change, which still match and are read from the cache. */
  matching: number
  /**
   * Blocks behind those figures whose size is unknown and is not counted: `item_reference` items, binary
   * data replaced by its hash, blocks a trace records without content. Absent when there are none.
   */
  unsized?: number
  /** What re-reading them costs above the cache-read price, at list prices, for this one call. Absent when the model has no price. */
  cost?: BreakCost
}

export interface BreakCost {
  /** The extra cost of this call's re-read, in `currency`: a break that happens on every call costs this each time. */
  extra: number
  currency: string
  /** The model it was priced as. */
  model: string
}

/** What the price of a break is looked up by. */
export interface BreakPricing {
  /** The table to price with; false for no price. Default: the pricing table bundled with prefixlens. */
  table?: PricingTable | false
  provider?: string
  model: string
  params?: Record<string, unknown>
  /** When the request was sent, for prices that apply on set days. Default: now. */
  ts?: string
}

/**
 * The size of a break whose first change is at block `changedAt` (an index into both lists: the blocks
 * before it are the same in each), and its price when `pricing` finds one.
 */
export function breakSize(before: Block[], after: Block[], changedAt: number, pricing: BreakPricing): BreakSize {
  const matching = sized(before.slice(0, changedAt))
  const cached = sized(before.slice(changedAt))
  const sent = sized(after.slice(changedAt))
  const behind = cached.tokens <= sent.tokens ? cached : sent
  const reread = behind.tokens
  const unsized = matching.unsized + behind.unsized
  const cost = reread > 0 ? priceOf(after, changedAt, reread, matching.tokens + sent.tokens, pricing) : undefined
  return { reread, matching: matching.tokens, ...(unsized > 0 ? { unsized } : {}), ...(cost ? { cost } : {}) }
}

/** The failure message's line for a break of this size, or undefined when nothing cached is re-read. */
export function sizeLine(size: BreakSize): string | undefined {
  if (size.reread === 0) return undefined
  const still = size.matching > 0 ? ` and about ${about(size.matching)} still match` : ""
  const unsized = size.unsized ? `; ${size.unsized} ${size.unsized === 1 ? "block" : "blocks"} of unknown size not counted` : ""
  const tokens = `about ${about(size.reread)} tokens are re-read${still} (an estimate from the request text${unsized})`
  if (!size.cost) return `size: ${tokens}`
  return `size: ${tokens}; at ${size.cost.model} list prices that is ${amount(size.cost.extra, size.cost.currency)} more than reading them from the cache, each time this happens`
}

/** The extra cost of re-reading `reread` tokens, as the trace path costs a miss: lost tokens × (the uncached rate − the cache-read rate). */
function priceOf(after: Block[], changedAt: number, reread: number, prompt: number, pricing: BreakPricing): BreakCost | undefined {
  const table = pricing.table === undefined ? bundledPricing() : pricing.table
  if (!table || pricing.model === "") return undefined
  // The part of the re-read up to the request's last cache breakpoint is written to the cache again, at
  // the cache-write price; the rest is uncached input. Without breakpoints it is all input.
  const lastBreakpoint = after.findLastIndex((block) => block.breakpoint)
  const written = Math.min(reread, lastBreakpoint < changedAt ? 0 : sized(after.slice(changedAt, lastBreakpoint + 1)).tokens)
  const usage = { input_tokens: reread - written, cache_read_tokens: prompt - reread, cache_write_tokens: written, output_tokens: 0 }
  const context = { ts: pricing.ts ?? new Date().toISOString(), ...(pricing.params ? { params: pricing.params } : {}) }
  const resolution = resolvePrice({ table }, pricing.provider ?? "", pricing.model, usage, context)
  if (resolution.source === "none") return undefined
  const rates = ratesFor(resolution.entry, prompt)
  const extra = (reread * Math.max(0, uncachedRate(usage, rates) - rates.cache_read)) / 1e6
  return { extra, currency: table.currency, model: pricing.model }
}

/** Estimated tokens of blocks whose content is known, and how many are not. */
function sized(blocks: Block[]): { tokens: number; unsized: number } {
  let chars = 0
  let unsized = 0
  for (const block of blocks) {
    if (block.content === undefined || block.unknown || block.elided || isItemReference(block)) unsized++
    else chars += JSON.stringify(block.content)?.length ?? 0
  }
  return { tokens: tokensFromChars(chars), unsized }
}

/** "18,000", "1,300", "440", "12": two significant figures from 100 up, since the count is an estimate. */
function about(tokens: number): string {
  const rounded = tokens < 100 ? tokens : Number(tokens.toPrecision(2))
  return rounded.toLocaleString("en-US")
}

/** A pricing table read from a local file at once, or undefined when it is missing, unreadable or invalid. */
export function readTableSync(file: URL | string): PricingTable | undefined {
  try {
    return parsePricing(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return undefined
  }
}

/** "about $0.05", "about $0.0044", "about $0.000053": cents from a cent up, else two significant figures. */
function amount(value: number, currency: string): string {
  const money = (figure: string) => (currency === "USD" ? `$${figure}` : `${figure} ${currency}`)
  if (value < 0.000_001) return `less than ${money("0.000001")}`
  return `about ${money(value >= 0.01 ? value.toFixed(2) : value.toPrecision(2))}`
}

// undefined: not read yet; null: could not be read, so breaks are not priced.
let bundled: PricingTable | null | undefined

function bundledPricing(): PricingTable | undefined {
  if (bundled === undefined) bundled = readTableSync(DEFAULT_PRICING_URL) ?? null
  return bundled ?? undefined
}
