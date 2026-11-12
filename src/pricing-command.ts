// `prefixlens pricing update | check | show`: the only commands that touch the network, and only
// update and check do, with one GET to CATALOGUE_URL (or none with --from).

import os from "node:os"
import { providerFamily } from "./provider.ts"
import {
  CATALOGUE_URL,
  catalogueProvider,
  cataloguePath,
  compareCatalogues,
  compareTables,
  convertCatalogue,
  fetchCatalogue,
  findCatalogueEntry,
  loadCatalogue,
  readCatalogueFile,
  resolvePrice,
  writeCatalogue,
  type CatalogueEntry,
  type CatalogueTable,
  type FieldDifference,
  type TableComparison,
} from "./catalogue.ts"
import { findFamily, loadPricing, providerFacts, type PriceEntry, type PricingTable } from "./pricing.ts"

export interface PricingOptions {
  /** A saved copy of api.json to read instead of fetching. */
  from?: string
  /** An explicit pricing table (--pricing), else $PREFIXLENS_PRICING, else the bundled one. */
  pricing?: string
  catalogueProviders?: Record<string, string>
  provider?: string
  date?: string
  json?: boolean
  all?: boolean
  noCatalogue?: boolean
}

export async function runPricing(command: string | undefined, args: string[], options: PricingOptions): Promise<number> {
  if (command === "update") return update(options)
  if (command === "check") return check(options)
  if (command === "show") return show(args[0], options)
  console.error("prefixlens: usage: prefixlens pricing update | check | show <model>; run prefixlens --help")
  return 1
}

async function update(options: PricingOptions): Promise<number> {
  const table = await obtain(options.from)
  const file = cataloguePath()
  const previous = await loadCatalogue(file).catch(() => undefined)
  const changes = compareCatalogues(previous, table)
  await writeCatalogue(table, file)
  const base = await loadPricing(options.pricing)
  const comparison = compareTables(base, table, today())
  const out: string[] = []
  const providers = new Set(table.models.map((entry) => entry.provider)).size
  out.push(`read ${table.read_from}: ${count(table.models.length, "priced model")} from ${count(providers, "provider")}`)
  out.push(`wrote ${tilde(file)}`)
  out.push(`  models.dev data, MIT licence, Copyright (c) 2025 models.dev. Reports use it for models the pricing table does not list; delete the file to stop.`)
  if (!previous) out.push("no earlier fetch to compare with")
  else {
    out.push(
      `since the fetch of ${previous.fetched_at.slice(0, 10)}: ${count(changes.added.length, "model")} added, ${changes.removed.length} removed, ${count(changes.changed.length, "price")} changed`,
    )
    out.push(...limit(changes.added.map((entry) => `  + ${entry.provider} ${entry.id}  ${rateText(entry)}`), options.all))
    out.push(...limit(changes.removed.map((entry) => `  - ${entry.provider} ${entry.id}`), options.all))
    out.push(...limit(changes.changed.map((change) => `  ~ ${change.after.provider} ${change.after.id}: ${changeText(change.differences)}`), options.all))
  }
  out.push(...comparisonLines(comparison, tableLabel(options.pricing), base, table, options.all))
  console.log(out.join("\n"))
  return 0
}

async function check(options: PricingOptions): Promise<number> {
  const table = await obtain(options.from)
  const base = await loadPricing(options.pricing)
  const comparison = compareTables(base, table, today())
  if (options.json) {
    const disagreements = comparison.disagreements.map((item) => ({
      provider: item.provider,
      model: item.model,
      ...(item.when_params ? { when_params: item.when_params } : {}),
      catalogue: { provider: item.catalogue.provider, id: item.catalogue.id, ...(item.catalogue.last_updated ? { last_updated: item.catalogue.last_updated } : {}) },
      differences: item.differences,
    }))
    console.log(JSON.stringify({ catalogue: { read_from: table.read_from, fetched_at: table.fetched_at }, table: tableLabel(options.pricing), shared: comparison.shared.length, missing: comparison.missing, disagreements }, null, 2))
  } else console.log([`read ${table.read_from}`, ...comparisonLines(comparison, tableLabel(options.pricing), base, table, true)].join("\n"))
  return comparison.disagreements.length > 0 ? 1 : 0
}

async function show(model: string | undefined, options: PricingOptions): Promise<number> {
  if (!model) return fail("usage: prefixlens pricing show <model> [--provider <name>] [--date YYYY-MM-DD]")
  const provider = options.provider ?? providerFamily("", model)
  if (!provider) return fail(`cannot tell the provider of ${model}; pass --provider (anthropic, openai, gemini, or a models.dev provider id)`)
  const day = options.date ?? today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail("--date must be YYYY-MM-DD")
  const table = await loadPricing(options.pricing)
  const catalogue = options.noCatalogue ? undefined : await loadCatalogue()
  const usage = { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 }
  const sources = { table, ...(catalogue ? { catalogue } : {}), ...(options.catalogueProviders ? { catalogueProviders: options.catalogueProviders } : {}) }
  const resolution = resolvePrice(sources, provider, model, usage, { ts: `${day}T12:00:00Z` })
  const out = [`${model} (${provider}) on ${day}`]
  const fetched = catalogue ? `fetched ${catalogue.fetched_at.slice(0, 10)}` : ""
  if (resolution.source === "table") {
    const checked = table.sources?.[resolution.entry.provider ?? provider]?.checked ?? table.as_of
    out.push(`  source       ${tableLabel(options.pricing)}${checked ? `, checked ${checked}` : ""}${resolution.entry.provider ? ` (${resolution.entry.provider} entry)` : ""}`)
    out.push(...entryLines(resolution.entry, providerFacts(table, provider, resolution.entry, model)))
    const own = catalogueProvider(resolution.entry.provider ?? provider)
    const compared = catalogue ? findCatalogueEntry(catalogue, own, model) : undefined
    if (!catalogue) out.push("  models.dev   not fetched (prefixlens pricing update)")
    else if (!compared) out.push(`  models.dev   ${own} has no ${model}`)
    else if ("ambiguous" in compared) out.push(`  models.dev   ambiguous: ${compared.ambiguous.map((entry) => entry.id).join(", ")}`)
    else if (!resolution.differences) out.push(`  models.dev   ${describe(compared.entry)} agrees (${updated(compared.entry)}${fetched})`)
    else out.push(`  models.dev   ${describe(compared.entry)} (${updated(compared.entry)}${fetched}) DISAGREES: ${diffText(resolution.differences)}; the pricing table's figures are used`)
    return print(out)
  }
  if (resolution.source === "catalogue" || resolution.catalogue) {
    const entry = resolution.source === "catalogue" ? resolution.catalogue : resolution.catalogue!
    out.push(`  source       models.dev ${describe(entry)} (${updated(entry)}${fetched}): community-maintained, not hand-verified`)
    const family = findFamily(table, provider, model)
    out.push(...catalogueLines(entry, providerFacts(table, provider, undefined, model), family ? `the pricing table's ${family.prefixes[0]} family` : "provider defaults: models.dev has neither"))
    return print(out)
  }
  if (resolution.listed) out.push(`  no price on ${day}: the pricing table lists ${model} only on other days or with other parameters, and the catalogue is not used for a model it lists`)
  else if (resolution.excluded) out.push(`  no price: left unpriced on purpose by ${tableLabel(options.pricing)} (${resolution.excluded.reason}); the catalogue is not used for it either`)
  else if (resolution.ambiguous) out.push(`  no price: models.dev ${resolution.ambiguous[0]!.provider} lists ${resolution.ambiguous.map((entry) => entry.id).join(", ")} at different prices; give the full id`)
  else if (!catalogue) out.push(`  no price: not in ${tableLabel(options.pricing)}, and no models.dev catalogue has been fetched (prefixlens pricing update)`)
  else out.push(`  no price: not in ${tableLabel(options.pricing)}, and models.dev ${catalogueProvider(provider, options.catalogueProviders)} has no ${model} (other providers' prices are used only with --catalogue-provider)`)
  return print(out)
}

async function obtain(from: string | undefined): Promise<CatalogueTable> {
  const raw = from ? await readCatalogueFile(from) : await fetchCatalogue()
  return convertCatalogue(raw, from ?? CATALOGUE_URL)
}

function comparisonLines(comparison: TableComparison, label: string, base: PricingTable, catalogue: CatalogueTable, all: boolean | undefined): string[] {
  const lines = [
    `compared with ${label}${base.as_of ? ` (as of ${base.as_of})` : ""}: ${count(comparison.shared.length, "model id")} in both, ${comparison.missing.length} not in models.dev under the same provider, ${count(comparison.disagreements.length, "disagreement")}`,
  ]
  lines.push(
    ...limit(
      comparison.disagreements.map((item) => {
        const checked = base.sources?.[item.provider]?.checked ?? base.as_of
        const mode = item.when_params ? ` ${JSON.stringify(item.when_params)}` : ""
        return `  ! ${item.provider} ${item.model}${mode}: ${diffText(item.differences)} (table${checked ? ` checked ${checked}` : ""}; models.dev ${describe(item.catalogue)}, ${updated(item.catalogue)}fetched ${catalogue.fetched_at.slice(0, 10)})`
      }),
      all,
    ),
  )
  return lines
}

function entryLines(entry: PriceEntry, facts: { cache_ttl_seconds: number; min_cacheable_tokens: number }): string[] {
  return [
    `  input        ${money(entry.input)}`,
    `  cache read   ${money(entry.cache_read)}`,
    `  cache write  ${entry.cache_write === undefined ? "none listed (priced at input)" : money(entry.cache_write)}${entry.cache_write_1h !== undefined ? ` · 1 hour ${money(entry.cache_write_1h)}` : ""}${entry.cache_write_12h !== undefined ? ` · 12 hours ${money(entry.cache_write_12h)}` : ""}`,
    `  output       ${money(entry.output)}   (USD per million tokens)`,
    ...(entry.tiers ?? []).map((tier) => `  above ${tier.above_prompt_tokens.toLocaleString("en-US")}  ${rateText({ ...entry, ...tier })}`),
    ...(entry.from || entry.until ? [`  in effect    ${entry.from ?? "…"} to ${entry.until ?? "…"}`] : []),
    `  cache        lifetime ${facts.cache_ttl_seconds} s, minimum ${facts.min_cacheable_tokens.toLocaleString("en-US")} tokens`,
  ]
}

function catalogueLines(entry: CatalogueEntry, facts: { cache_ttl_seconds: number; min_cacheable_tokens: number }, factsFrom: string): string[] {
  return [
    `  input        ${money(entry.input)}`,
    `  cache read   ${entry.cache_read === undefined ? "not listed: calls with this model are not costed" : money(entry.cache_read)}`,
    `  cache write  ${entry.cache_write === undefined ? "not listed: calls that write to the cache are not costed" : money(entry.cache_write)} · 1 hour and 12 hours: not in models.dev, calls with such writes are not costed`,
    `  output       ${money(entry.output)}   (USD per million tokens)${entry.reasoning !== undefined ? ` · reasoning ${money(entry.reasoning)}: calls reporting reasoning tokens are not costed` : ""}`,
    ...(entry.tiers ?? []).map((tier) => `  above ${tier.above_prompt_tokens.toLocaleString("en-US")}  ${rateText(tier)}`),
    ...(entry.modes ?? []).map((mode) => `  ${mode.name} mode  ${JSON.stringify(mode.when_params)}: ${mode.input === undefined ? "no price listed, such calls are not costed" : rateText(mode)}${"service_tier" in mode.when_params ? " (not applied, as in the pricing table)" : ""}`),
    `  cache        lifetime ${facts.cache_ttl_seconds} s, minimum ${facts.min_cacheable_tokens.toLocaleString("en-US")} tokens (${factsFrom})`,
    ...(entry.status ? [`  status       ${entry.status}`] : []),
  ]
}

function rateText(rates: { input?: number; output?: number; cache_read?: number; cache_write?: number }): string {
  return [`input ${opt(rates.input)}`, `cache read ${opt(rates.cache_read)}`, `cache write ${opt(rates.cache_write)}`, `output ${opt(rates.output)}`].join(" · ")
}

function diffText(differences: FieldDifference[]): string {
  return differences.map((difference) => `${difference.field.replaceAll("_", " ")} ${opt(difference.table, "none")} vs ${opt(difference.catalogue, "none")}`).join(", ")
}

function changeText(differences: FieldDifference[]): string {
  return differences.map((difference) => (difference.table === undefined && difference.catalogue === undefined ? difference.field : `${difference.field} ${opt(difference.table, "none")} -> ${opt(difference.catalogue, "none")}`)).join(", ")
}

function describe(entry: CatalogueEntry): string {
  return `${entry.provider} ${entry.id}`
}

function updated(entry: CatalogueEntry): string {
  return entry.last_updated ? `last updated ${entry.last_updated}, ` : ""
}

function tableLabel(pricing: string | undefined): string {
  const file = pricing || process.env.PREFIXLENS_PRICING
  return file ? `the pricing table ${file}` : "the bundled pricing.json"
}

function money(value: number): string {
  return `$${Number(value.toFixed(6))}`
}

function opt(value: number | undefined, absent = "not listed"): string {
  return value === undefined ? absent : money(value)
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`
}

function limit(lines: string[], all: boolean | undefined): string[] {
  if (all || lines.length <= 20) return lines
  return [...lines.slice(0, 20), `  ... ${lines.length - 20} more (--all lists every one)`]
}

function tilde(file: string): string {
  const home = os.homedir()
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function print(lines: string[]): number {
  console.log(lines.join("\n"))
  return 0
}

function fail(message: string): number {
  console.error(`prefixlens: ${message}`)
  return 1
}
