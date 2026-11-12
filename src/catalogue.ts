// The models.dev catalogue as an optional second source of prices. It is fetched only when the
// user runs `prefixlens pricing update` or `pricing check`, converted to the shape below, and
// written to the user's cache directory. Reports read it as an overlay: the hand-verified table
// wins for every model it lists, and the catalogue prices only the models the table lacks.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isRecord } from "./canonical.ts"
import { findPrice, listsModel, normalizeModelId, type PriceContext, type PriceEntry, type PricingTable } from "./pricing.ts"
import type { Usage } from "./trace.ts"
import { promptTokens } from "./usage.ts"

/** The one URL prefixlens ever fetches, and only from `pricing update` and `pricing check`. */
export const CATALOGUE_URL = "https://models.dev/api.json"
export const CATALOGUE_REPOSITORY = "https://github.com/anomalyco/models.dev"
/** The catalogue was about 6 MB in November 2026; a response above this is refused. */
export const CATALOGUE_MAX_BYTES = 32 * 1024 * 1024
export const CATALOGUE_TIMEOUT_MS = 30_000
export const CATALOGUE_FILE = "models.dev.json"

// models.dev is published under the MIT licence, which asks for its notice in every copy or
// substantial portion; the converted file is one, so the notice is written into it.
const LICENCE_TEXT = `MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

/** Prices per million tokens as the catalogue gives them. A field the catalogue does not list is absent, never zero. */
export interface CatalogueRates {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  /** A reasoning-token price different from the output price. */
  reasoning?: number
}

export interface CatalogueEntry extends CatalogueRates {
  /** The catalogue's provider id (`anthropic`, `google`, `openrouter`, ...). */
  provider: string
  /** The catalogue's model id under that provider, as listed (`claude-opus-5-5`, `anthropic/claude-opus-5.5`). */
  id: string
  input: number
  output: number
  /** Whole-request prices above a prompt size (models.dev `tiers` of type `context`). */
  tiers?: (CatalogueRates & { above_prompt_tokens: number })[]
  /** Prices selected by request parameters (models.dev `experimental.modes`), e.g. `{"speed": "fast"}`. */
  modes?: (CatalogueRates & { name: string; when_params: Record<string, unknown> })[]
  last_updated?: string
  status?: string
}

export interface CatalogueTable {
  format: "prefixlens-catalogue"
  version: 1
  source: { name: "models.dev"; url: string; repository: string; licence: "MIT"; copyright: string; licence_text: string }
  /** When it was fetched (or converted from a local file), ISO 8601. */
  fetched_at: string
  /** The URL or local file it was converted from. */
  read_from: string
  currency: "USD"
  unit: "per_million_tokens"
  notes: string[]
  models: CatalogueEntry[]
}

/** Which catalogue provider prices a trace's provider, unless the user maps it elsewhere. Any other provider id maps to itself. */
export const CATALOGUE_PROVIDERS: Record<string, string> = { anthropic: "anthropic", openai: "openai", gemini: "google" }

// ---------------------------------------------------------------------------------------------
// Location

/**
 * Where `pricing update` writes the converted catalogue: `$XDG_CACHE_HOME/prefixlens` when that is
 * set, else `~/Library/Caches/prefixlens` on macOS, `%LOCALAPPDATA%\prefixlens\Cache` on Windows,
 * and `~/.cache/prefixlens` elsewhere. It is a cache: deleting it only removes the catalogue prices.
 */
export function catalogueDir(env: Record<string, string | undefined> = process.env, platform: string = process.platform, home = os.homedir()): string {
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "prefixlens")
  if (platform === "darwin") return path.join(home, "Library", "Caches", "prefixlens")
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "prefixlens", "Cache")
  return path.join(home, ".cache", "prefixlens")
}

export function cataloguePath(env: Record<string, string | undefined> = process.env): string {
  return path.join(catalogueDir(env), CATALOGUE_FILE)
}

// ---------------------------------------------------------------------------------------------
// Fetching and reading

export interface FetchOptions {
  /** For tests only; the CLI always fetches CATALOGUE_URL. */
  url?: string
  timeoutMs?: number
  maxBytes?: number
}

/**
 * GETs the catalogue: no body, no cookies or credentials, no redirects followed. Fails with a
 * readable message when offline, on a timeout, on an HTTP error, or when the response is larger
 * than `maxBytes`.
 */
export async function fetchCatalogue(options: FetchOptions = {}): Promise<unknown> {
  const url = options.url ?? CATALOGUE_URL
  const timeout = options.timeoutMs ?? CATALOGUE_TIMEOUT_MS
  const limit = options.maxBytes ?? CATALOGUE_MAX_BYTES
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "manual", headers: { accept: "application/json" } }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error(`${url} did not answer within ${timeout / 1000} s; use --from <file> to read a saved copy`)
    throw new Error(`could not fetch ${url} (offline?): ${error instanceof Error ? error.message : String(error)}; use --from <file> to read a saved copy`)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${url} answered HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get("content-length"))
  if (declared > limit) {
    await response.body?.cancel()
    throw new Error(`${url} sent ${megabytes(declared)}, more than the ${megabytes(limit)} limit`)
  }
  const text = await readLimited(response, url, limit, timeout)
  return parseJson(text, url)
}

/** Reads a saved copy of https://models.dev/api.json. */
export async function readCatalogueFile(file: string, maxBytes = CATALOGUE_MAX_BYTES): Promise<unknown> {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`catalogue file not found: ${file}`)
  if (info.size > maxBytes) throw new Error(`${file} is ${megabytes(info.size)}, more than the ${megabytes(maxBytes)} limit`)
  return parseJson(await readFile(file, "utf8"), file)
}

async function readLimited(response: Response, url: string, limit: number, timeout: number): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  if (!reader) return ""
  for (;;) {
    const next = await reader.read().catch((error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error(`${url} did not finish within ${timeout / 1000} s`)
      throw new Error(`reading ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (next.done) break
    size += next.value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error(`${url} sent more than the ${megabytes(limit)} limit`)
    }
    chunks.push(next.value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function parseJson(text: string, from: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${from} is not valid JSON`)
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------------------------
// Conversion

/** Converts models.dev's api.json into the catalogue table. Models without an input and output price are left out. */
export function convertCatalogue(raw: unknown, readFrom: string, now = new Date()): CatalogueTable {
  if (!isRecord(raw)) throw new Error(`${readFrom} is not a models.dev catalogue: expected an object of providers`)
  const providers = Object.entries(raw).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]) && isRecord(entry[1].models))
  if (providers.length === 0) throw new Error(`${readFrom} is not a models.dev catalogue: no provider has a models object`)
  const models = providers
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([provider, value]) =>
      Object.entries(value.models as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, model]) => convertModel(provider, id, model))
        .filter((entry) => entry !== undefined),
    )
  return {
    format: "prefixlens-catalogue",
    version: 1,
    source: { name: "models.dev", url: CATALOGUE_URL, repository: CATALOGUE_REPOSITORY, licence: "MIT", copyright: "Copyright (c) 2025 models.dev", licence_text: LICENCE_TEXT },
    fetched_at: now.toISOString(),
    read_from: readFrom,
    currency: "USD",
    unit: "per_million_tokens",
    notes: [
      "Converted by prefixlens from the models.dev catalogue (https://models.dev), a community-maintained database of models and prices, used under the MIT licence above.",
      "prefixlens uses these prices only for models its pricing table does not list. A field models.dev does not list is left out, never set to zero.",
      "Regenerate with `prefixlens pricing update`; delete this file to stop using it.",
    ],
    models,
  }
}

function convertModel(provider: string, id: string, model: unknown): CatalogueEntry | undefined {
  if (!isRecord(model) || !isRecord(model.cost)) return undefined
  // Ids and dates are printed to the terminal; one carrying control characters (escape sequences) is not a real id.
  if ([provider, id, model.last_updated, model.status].some((text) => typeof text === "string" && /[\u0000-\u001f\u007f-\u009f]/.test(text))) return undefined
  const cost = model.cost
  const base = rates(cost)
  if (base.input === undefined || base.output === undefined) return undefined
  // A tier of a kind other than prompt size would make the base price wrong for some calls, so such a model is left out.
  const rawTiers = Array.isArray(cost.tiers) ? cost.tiers : []
  const tiers = rawTiers.map((tier) => (isRecord(tier) && isRecord(tier.tier) && tier.tier.type === "context" && isPrice(tier.tier.size) ? { above_prompt_tokens: tier.tier.size, ...rates(tier) } : undefined))
  if (tiers.some((tier) => tier === undefined)) return undefined
  const modes = isRecord(model.experimental) && isRecord(model.experimental.modes) ? Object.entries(model.experimental.modes).flatMap(([name, mode]) => convertMode(name, mode)) : []
  return {
    provider,
    id,
    ...base,
    input: base.input,
    output: base.output,
    ...(tiers.length > 0 ? { tiers: tiers.filter((tier) => tier !== undefined).sort((a, b) => a.above_prompt_tokens - b.above_prompt_tokens) } : {}),
    ...(modes.length > 0 ? { modes } : {}),
    ...(typeof model.last_updated === "string" ? { last_updated: model.last_updated } : {}),
    ...(typeof model.status === "string" ? { status: model.status } : {}),
  }
}

// A mode selects its price by request body fields. One without a cost of its own is kept with no
// prices, so that a call in that mode is reported as unpriced rather than priced at the base rate.
function convertMode(name: string, mode: unknown) {
  if (!isRecord(mode) || !isRecord(mode.provider) || !isRecord(mode.provider.body) || Object.keys(mode.provider.body).length === 0) return []
  return [{ name, when_params: mode.provider.body, ...(isRecord(mode.cost) ? rates(mode.cost) : {}) }]
}

function rates(value: Record<string, unknown>): CatalogueRates {
  const pick = (field: keyof CatalogueRates) => (isPrice(value[field]) ? { [field]: value[field] as number } : {})
  const reasoning = isPrice(value.reasoning) && value.reasoning !== value.output ? { reasoning: value.reasoning as number } : {}
  return { ...pick("input"), ...pick("output"), ...pick("cache_read"), ...pick("cache_write"), ...reasoning }
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

// ---------------------------------------------------------------------------------------------
// Storage

/** Writes the table to `file` (default: the cache location), replacing any earlier one in a single rename. */
export async function writeCatalogue(table: CatalogueTable, file = cataloguePath()): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  const { models, ...header } = table
  // One model per line keeps the file small and diffable.
  const text = `${JSON.stringify(header, null, 2).slice(0, -2)},\n  "models": [\n${models.map((model) => `    ${JSON.stringify(model)}`).join(",\n")}\n  ]\n}\n`
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, file)
  return file
}

/** The converted catalogue at `file`, or undefined when there is none. Throws when the file is not one prefixlens wrote. */
export async function loadCatalogue(file = cataloguePath()): Promise<CatalogueTable | undefined> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return undefined
  const value: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  if (!isRecord(value) || value.format !== "prefixlens-catalogue" || !Array.isArray(value.models) || typeof value.fetched_at !== "string")
    throw new Error(`${file} is not a catalogue written by prefixlens pricing update; delete it or run the update again`)
  value.models.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.provider !== "string" || typeof entry.id !== "string" || !isPrice(entry.input) || !isPrice(entry.output))
      throw new Error(`${file}: models[${index}] is malformed; delete the file or run prefixlens pricing update again`)
  })
  return value as unknown as CatalogueTable
}

// ---------------------------------------------------------------------------------------------
// Lookup

export type CatalogueMatch = { entry: CatalogueEntry } | { ambiguous: CatalogueEntry[] } | undefined

const indexes = new WeakMap<CatalogueTable, Map<string, CatalogueEntry[]>>()

/**
 * The catalogue entry of one catalogue provider for a trace's model id. Never looks at another
 * provider. Tried in order:
 * 1. the id as given, then without each leading `segment/` (`openrouter/anthropic/claude-x`,
 *    `anthropic/claude-x`, `claude-x`), compared lowercase with `.` and `@` read as `-`;
 * 2. the id normalized as for the pricing table (router, region and version parts removed) against
 *    each entry's id normalized the same way. Several candidates with different prices (a cloud's
 *    regional ids, a router's vendors) are ambiguous and give no price.
 */
export function findCatalogueEntry(table: CatalogueTable, provider: string, model: string): CatalogueMatch {
  const entries = providerIndex(table).get(provider) ?? []
  const segments = model.trim().split("/")
  for (const candidate of segments.map((_, index) => key(segments.slice(index).join("/")))) {
    const exact = entries.filter((entry) => key(entry.id) === candidate)
    if (exact.length > 0) return pick(exact)
  }
  const id = normalizeModelId(model)
  const loose = entries.filter((entry) => normalizeModelId(entry.id) === id)
  return loose.length === 0 ? undefined : pick(loose)
}

function pick(candidates: CatalogueEntry[]): CatalogueMatch {
  const first = candidates[0]!
  const same = candidates.every((entry) => JSON.stringify(priceOnly(entry)) === JSON.stringify(priceOnly(first)))
  return same ? { entry: first } : { ambiguous: candidates }
}

function priceOnly(entry: CatalogueEntry) {
  return { input: entry.input, output: entry.output, cache_read: entry.cache_read, cache_write: entry.cache_write, reasoning: entry.reasoning, tiers: entry.tiers, modes: entry.modes }
}

function providerIndex(table: CatalogueTable): Map<string, CatalogueEntry[]> {
  const cached = indexes.get(table)
  if (cached) return cached
  const index = new Map<string, CatalogueEntry[]>()
  for (const entry of table.models) index.set(entry.provider, [...(index.get(entry.provider) ?? []), entry])
  indexes.set(table, index)
  return index
}

function key(id: string): string {
  return id.trim().toLowerCase().replaceAll("@", "-").replaceAll(".", "-")
}

/** The catalogue provider that prices a trace provider: the user's mapping, else CATALOGUE_PROVIDERS, else the same id. */
export function catalogueProvider(traceProvider: string, mapping: Record<string, string> = {}): string {
  return mapping[traceProvider] ?? CATALOGUE_PROVIDERS[traceProvider] ?? traceProvider
}

/** Parses `anthropic=openrouter,openai=openrouter` into a mapping. */
export function parseProviderMapping(text: string): Record<string, string> {
  const pairs = text.split(",").map((pair) => pair.trim()).filter((pair) => pair !== "")
  const mapping = pairs.map((pair) => pair.split("="))
  if (mapping.length === 0 || mapping.some((parts) => parts.length !== 2 || !parts[0] || !parts[1]))
    throw new Error(`expected <trace provider>=<models.dev provider>[,...], got ${text}`)
  return Object.fromEntries(mapping.map((parts) => [parts[0]!.trim(), parts[1]!.trim()]))
}

// ---------------------------------------------------------------------------------------------
// Resolving a call's price across both sources

export interface PriceSources {
  table: PricingTable
  catalogue?: CatalogueTable
  /** Trace provider to catalogue provider, overriding CATALOGUE_PROVIDERS. Opting in to a router's or cloud's prices goes here. */
  catalogueProviders?: Record<string, string>
}

export interface FieldDifference {
  field: string
  table?: number
  catalogue?: number
}

export type Resolution =
  | { source: "table"; entry: PriceEntry; differences?: FieldDifference[]; compared?: CatalogueEntry }
  | { source: "catalogue"; entry: PriceEntry; catalogue: CatalogueEntry; mode?: string }
  | { source: "none"; catalogue?: CatalogueEntry; missing?: string[]; ambiguous?: CatalogueEntry[]; alias?: CatalogueEntry; listed?: boolean }

/**
 * The price for one call. The pricing table wins for every model it lists, even on a day it gives
 * no price for; its entry is compared with the catalogue's for the same provider and model, and
 * differences are returned for the report to note. The catalogue prices only models the table
 * does not list, and only from the catalogue provider the trace provider maps to. A catalogue
 * price is used only when it lists every price the call needs; otherwise the call has no price.
 */
export function resolvePrice(sources: PriceSources, provider: string, model: string, usage: Usage, context: PriceContext = {}): Resolution {
  const entry = findPrice(sources.table, provider, model, context)
  if (entry) {
    // The table's entries are first-party list prices, so they are compared with the first-party catalogue entry, whatever the user maps the provider to.
    const compared = sources.catalogue ? findCatalogueEntry(sources.catalogue, catalogueProvider(entry.provider ?? provider), model) : undefined
    const differences = compared && "entry" in compared ? compareEntry(entry, compared.entry) : undefined
    return { source: "table", entry, ...(differences && differences.length > 0 ? { differences, compared: (compared as { entry: CatalogueEntry }).entry } : {}) }
  }
  if (listsModel(sources.table, provider, model) || !sources.catalogue) return { source: "none", listed: listsModel(sources.table, provider, model) }
  const match = findCatalogueEntry(sources.catalogue, catalogueProvider(provider, sources.catalogueProviders), model)
  if (!match) return { source: "none" }
  if ("ambiguous" in match) return { source: "none", ambiguous: match.ambiguous }
  if (isMovingAlias(match.entry.id)) return { source: "none", alias: match.entry }
  const priced = catalogueRates(match.entry, usage, context.params)
  if (priced.missing.length > 0) return { source: "none", catalogue: match.entry, missing: priced.missing }
  return { source: "catalogue", entry: priced.entry!, catalogue: match.entry, ...(priced.mode ? { mode: priced.mode } : {}) }
}

/**
 * True for ids such as `gemini-flash-latest` that a provider repoints at another model without
 * notice. The pricing table leaves them unpriced on purpose, so the catalogue's price for one
 * (whichever model it pointed at when someone last edited it) is not used either.
 */
export function isMovingAlias(id: string): boolean {
  return /(^|[-/.:])latest$/i.test(id.trim())
}

/**
 * A price entry for one call from a catalogue entry: the mode its parameters select, then the
 * prompt-size tier. Lists the prices the call needs and the catalogue does not give: the cache-read
 * price always (a miss is costed against it), the write price when the call wrote to the cache,
 * the 1-hour write price when it wrote with a 1-hour lifetime (models.dev has none), and a separate
 * reasoning price when the call reports reasoning tokens.
 */
export function catalogueRates(entry: CatalogueEntry, usage: Usage, params?: Record<string, unknown>): { entry?: PriceEntry; missing: string[]; mode?: string } {
  // OpenAI's service tiers are left out, as in the pricing table: a request's service_tier does not say which tier billed it.
  const mode = (entry.modes ?? []).find((candidate) => !("service_tier" in candidate.when_params) && contains(params, candidate.when_params))
  const prompt = promptTokens(usage)
  const tier = mode ? undefined : (entry.tiers ?? []).filter((candidate) => prompt > candidate.above_prompt_tokens).at(-1)
  const rates: CatalogueRates = mode ?? tier ?? entry
  const writes = usage.cache_write_tokens ?? 0
  const oneHour = Math.min(writes, usage.cache_write_1h_tokens ?? 0)
  if (mode && (mode.input === undefined || mode.output === undefined)) return { missing: [`${mode.name}_mode`], mode: mode.name }
  const missing = [
    ...(rates.input === undefined ? ["input"] : []),
    ...(rates.output === undefined ? ["output"] : []),
    ...(rates.cache_read === undefined ? ["cache_read"] : []),
    ...(writes - oneHour > 0 && rates.cache_write === undefined ? ["cache_write"] : []),
    ...(oneHour > 0 ? ["cache_write_1h"] : []),
    ...(rates.reasoning !== undefined && (usage.reasoning_tokens ?? 0) > 0 ? ["reasoning"] : []),
  ]
  if (missing.length > 0) return { missing, ...(mode ? { mode: mode.name } : {}) }
  return {
    entry: {
      provider: entry.provider,
      names: [entry.id],
      input: rates.input!,
      output: rates.output!,
      cache_read: rates.cache_read!,
      ...(rates.cache_write !== undefined ? { cache_write: rates.cache_write } : {}),
    },
    missing,
    ...(mode ? { mode: mode.name } : {}),
  }
}

/** Fields both sources list with different figures, and tiers only one side has. */
export function compareEntry(entry: PriceEntry, catalogue: CatalogueEntry): FieldDifference[] {
  const mode = entry.when_params ? (catalogue.modes ?? []).find((candidate) => equal(candidate.when_params, entry.when_params)) : undefined
  // A bundled price for request parameters the catalogue has no mode for has nothing to compare against.
  if (entry.when_params && !mode) return []
  const base = differences("", entry, mode ?? catalogue)
  if (mode) return base
  const ours = entry.tiers ?? []
  const theirs = catalogue.tiers ?? []
  const sizes = [...new Set([...ours, ...theirs].map((tier) => tier.above_prompt_tokens))].sort((a, b) => a - b)
  return [
    ...base,
    ...sizes.flatMap((size) => {
      const a = ours.find((tier) => tier.above_prompt_tokens === size)
      const b = theirs.find((tier) => tier.above_prompt_tokens === size)
      if (!a || !b) return [{ field: `tier above ${size.toLocaleString("en-US")}`, ...(a ? { table: a.input ?? entry.input } : {}), ...(b ? { catalogue: b.input ?? catalogue.input } : {}) }]
      return differences(`tier above ${size.toLocaleString("en-US")} `, { ...entry, ...a }, { ...catalogue, ...b })
    }),
  ]
}

function differences(prefix: string, ours: Partial<PriceEntry>, theirs: CatalogueRates): FieldDifference[] {
  return (["input", "output", "cache_read", "cache_write"] as const).flatMap((field) => {
    const a = ours[field]
    const b = theirs[field]
    if (a === undefined || b === undefined || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))) return []
    return [{ field: `${prefix}${field}`, table: a, catalogue: b }]
  })
}

function contains(actual: unknown, expected: unknown): boolean {
  if (!isRecord(expected)) return actual === expected
  return isRecord(actual) && Object.entries(expected).every(([field, value]) => contains(actual[field], value))
}

function equal(a: unknown, b: unknown): boolean {
  return contains(a, b) && contains(b, a)
}

// ---------------------------------------------------------------------------------------------
// Comparing whole tables

export interface TableDisagreement {
  provider: string
  model: string
  catalogue: CatalogueEntry
  when_params?: Record<string, unknown>
  differences: FieldDifference[]
}

export interface TableComparison {
  /** Table model ids found in the catalogue under the same provider. */
  shared: string[]
  /** Table model ids the catalogue does not list (or lists ambiguously) under that provider. */
  missing: string[]
  disagreements: TableDisagreement[]
}

/** Compares every entry of the table in effect on `day` with the catalogue entry for the same provider and id. */
export function compareTables(table: PricingTable, catalogue: CatalogueTable, day: string): TableComparison {
  const shared = new Set<string>()
  const missing = new Set<string>()
  const disagreements: TableDisagreement[] = []
  for (const entry of table.models) {
    if (!entry.provider || !inEffectOn(entry, day)) continue
    for (const name of entry.names ?? []) {
      const label = `${entry.provider} ${name}`
      const match = findCatalogueEntry(catalogue, catalogueProvider(entry.provider), name)
      if (!match || "ambiguous" in match) {
        if (!entry.when_params) missing.add(label)
        continue
      }
      if (!entry.when_params) shared.add(label)
      const found = compareEntry(entry, match.entry)
      if (found.length > 0) disagreements.push({ provider: entry.provider, model: name, catalogue: match.entry, ...(entry.when_params ? { when_params: entry.when_params } : {}), differences: found })
    }
  }
  return { shared: [...shared], missing: [...missing].filter((label) => !shared.has(label)), disagreements }
}

function inEffectOn(entry: PriceEntry, day: string): boolean {
  return (!entry.from || day >= entry.from) && (!entry.until || day <= entry.until)
}

// ---------------------------------------------------------------------------------------------
// Comparing two fetches

export interface CatalogueChanges {
  added: CatalogueEntry[]
  removed: CatalogueEntry[]
  changed: { before: CatalogueEntry; after: CatalogueEntry; differences: FieldDifference[] }[]
}

export function compareCatalogues(before: CatalogueTable | undefined, after: CatalogueTable): CatalogueChanges {
  const id = (entry: CatalogueEntry) => `${entry.provider}\0${entry.id}`
  const old = new Map((before?.models ?? []).map((entry) => [id(entry), entry]))
  const current = new Map(after.models.map((entry) => [id(entry), entry]))
  return {
    added: before ? after.models.filter((entry) => !old.has(id(entry))) : [],
    removed: (before?.models ?? []).filter((entry) => !current.has(id(entry))),
    changed: after.models.flatMap((entry) => {
      const previous = old.get(id(entry))
      if (!previous || JSON.stringify(priceOnly(previous)) === JSON.stringify(priceOnly(entry))) return []
      const found = (["input", "output", "cache_read", "cache_write", "reasoning"] as const).flatMap((field) =>
        previous[field] === entry[field] ? [] : [{ field, ...(previous[field] !== undefined ? { table: previous[field] } : {}), ...(entry[field] !== undefined ? { catalogue: entry[field] } : {}) }],
      )
      return [{ before: previous, after: entry, differences: found.length > 0 ? found : [{ field: "tiers or modes" }] }]
    }),
  }
}
