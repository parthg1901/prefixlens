import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { analyze } from "../src/analyze.ts"
import {
  CATALOGUE_URL,
  catalogueDir,
  catalogueRates,
  compareCatalogues,
  compareTables,
  convertCatalogue,
  fetchCatalogue,
  findCatalogueEntry,
  loadCatalogue,
  parseProviderMapping,
  readCatalogueFile,
  resolvePrice,
  writeCatalogue,
  type CatalogueEntry,
  type PriceSources,
} from "../src/catalogue.ts"
import { loadPricing, parsePricing, providerFacts } from "../src/pricing.ts"
import type { Usage } from "../src/trace.ts"
import { usage, usageRecord } from "./helpers.ts"

const fixture = path.join(import.meta.dir, "fixtures", "catalogue", "api.json")
const raw = await Bun.file(fixture).json()
const catalogue = convertCatalogue(raw, fixture, new Date("2026-11-12T08:00:00Z"))
const bundled = await loadPricing()
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-catalogue-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const DAY = { ts: "2026-11-12T12:00:00Z" }
const none = usage(1000, 0, 0)
const sources = (extra: Partial<PriceSources> = {}): PriceSources => ({ table: bundled, catalogue, ...extra })
const entry = (provider: string, id: string): CatalogueEntry => {
  const match = findCatalogueEntry(catalogue, provider, id)
  if (!match || !("entry" in match)) throw new Error(`fixture has no single ${provider} ${id}`)
  return match.entry
}

describe("converting the models.dev catalogue", () => {
  test("keeps the prices it lists and leaves out the ones it does not, never as zero", () => {
    expect(entry("anthropic", "claude-zeta-noread")).toEqual({ provider: "anthropic", id: "claude-zeta-noread", input: 1, output: 5 })
    expect(entry("anthropic", "claude-zeta-nowrite").cache_write).toBeUndefined()
    expect(entry("google", "gemini-zeta")).toMatchObject({ input: 0.5, cache_read: 0.05, last_updated: "2026-08" })
  })

  test("prompt-size tiers become above_prompt_tokens, and modes keep their request parameters", () => {
    const zeta = entry("anthropic", "claude-zeta-1")
    expect(zeta.tiers).toEqual([{ above_prompt_tokens: 100000, input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }])
    expect(zeta.modes).toEqual([
      { name: "fast", when_params: { speed: "fast" }, input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
      { name: "deep", when_params: { thinking: { mode: "deep" } } },
    ])
  })

  test("leaves out models without an input and output price, or with a tier it cannot read", () => {
    const ids = catalogue.models.map((model) => model.id)
    expect(ids).not.toContain("gpt-image-zeta")
    expect(ids).not.toContain("gpt-zeta-free")
    expect(ids).not.toContain("gpt-zeta-hourly")
    expect(ids).toContain("deepseek-zeta")
    const hostile = convertCatalogue({ x: { models: { "evil\u001b[2Jid": { cost: { input: 1, output: 1 } }, fine: { cost: { input: 1, output: 1 }, status: "ok\u0007" } } } }, "x")
    expect(hostile.models).toEqual([])
  })

  test("a reasoning price equal to the output price is not kept as a separate price", () => {
    expect(entry("openai", "gpt-zeta-same").reasoning).toBeUndefined()
    expect(entry("openai", "gpt-zeta-reasoner").reasoning).toBe(8)
  })

  test("credits models.dev and carries its MIT notice", () => {
    expect(catalogue.source).toMatchObject({ name: "models.dev", url: CATALOGUE_URL, licence: "MIT", copyright: "Copyright (c) 2025 models.dev" })
    expect(catalogue.source.licence_text).toContain("The above copyright notice and this permission notice shall be included")
    expect(catalogue.fetched_at).toBe("2026-11-12T08:00:00.000Z")
  })

  test("rejects what is not a catalogue", () => {
    expect(() => convertCatalogue([], "x")).toThrow("x is not a models.dev catalogue")
    expect(() => convertCatalogue({ a: { name: "no models" } }, "x")).toThrow("no provider has a models object")
  })
})

describe("where the catalogue lives", () => {
  test("follows each platform's cache convention, and XDG_CACHE_HOME when set", () => {
    expect(catalogueDir({}, "linux", "/home/u")).toBe("/home/u/.cache/prefixlens")
    expect(catalogueDir({}, "darwin", "/Users/u")).toBe("/Users/u/Library/Caches/prefixlens")
    expect(catalogueDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(path.join("C:\\Users\\u\\AppData\\Local", "prefixlens", "Cache"))
    expect(catalogueDir({ XDG_CACHE_HOME: "/tmp/cache" }, "darwin", "/Users/u")).toBe("/tmp/cache/prefixlens")
  })

  test("is written and read back, and a missing file means no catalogue", async () => {
    const file = path.join(temp, "store", "models.dev.json")
    expect(await loadCatalogue(file)).toBeUndefined()
    await writeCatalogue(catalogue, file)
    expect(await loadCatalogue(file)).toEqual(catalogue)
    const text = await Bun.file(file).text()
    expect(text).toContain('"copyright": "Copyright (c) 2025 models.dev"')
    expect(text.split("\n").filter((line) => line.startsWith('    {"provider"')).length).toBe(catalogue.models.length)
  })

  test("a file prefixlens did not write is refused with what to do", async () => {
    const file = path.join(temp, "bad.json")
    await Bun.write(file, JSON.stringify({ models: [] }))
    expect(loadCatalogue(file)).rejects.toThrow("delete it or run the update again")
  })
})

describe("which source prices a call", () => {
  test("the pricing table wins for a model it lists, and agreeing figures give no note", () => {
    const resolution = resolvePrice(sources(), "anthropic", "claude-opus-5-5", none, DAY)
    expect(resolution.source).toBe("table")
    expect(resolution.source === "table" && resolution.differences).toBeFalsy()
  })

  test("a disagreement on a shared field is returned with both figures, and the table's price is used", () => {
    const resolution = resolvePrice(sources(), "anthropic", "claude-sonnet-5-5", none, DAY)
    if (resolution.source !== "table") throw new Error("expected the table's price")
    expect(resolution.entry.input).toBe(2)
    expect(resolution.differences).toEqual([{ field: "input", table: 2, catalogue: 3 }])
    expect(resolution.compared?.last_updated).toBe("2026-10-01")
  })

  test("fast mode in the table is compared with the catalogue's fast mode", () => {
    const resolution = resolvePrice(sources(), "anthropic", "claude-opus-5-5", none, { ...DAY, params: { speed: "fast" } })
    expect(resolution.source === "table" && resolution.entry.input).toBe(8)
    expect(resolution.source === "table" && resolution.differences).toBeFalsy()
  })

  test("a model the table lists only on other days gets no price, not the catalogue's", () => {
    const resolution = resolvePrice(sources(), "openai", "gpt-5.6-sol", none, { ts: "2026-12-05T12:00:00Z" })
    expect(resolution).toEqual({ source: "none", listed: true })
  })

  test("a model the table does not list is priced from the catalogue, tiers included", () => {
    const small = resolvePrice(sources(), "anthropic", "claude-zeta-1", none, DAY)
    expect(small.source).toBe("catalogue")
    expect(small.source === "catalogue" && small.entry).toMatchObject({ input: 1, cache_read: 0.1, cache_write: 1.25, output: 5 })
    const large = resolvePrice(sources(), "anthropic", "claude-zeta-1", usage(150000, 0, 0), DAY)
    expect(large.source === "catalogue" && large.entry).toMatchObject({ input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 })
  })

  test("an explicit table wins over the catalogue, glob patterns included", () => {
    const own = parsePricing({ models: [{ provider: "anthropic", match: "claude-*", input: 9, output: 9, cache_read: 9 }] })
    const resolution = resolvePrice(sources({ table: own }), "anthropic", "claude-zeta-1", none, DAY)
    expect(resolution.source === "table" && resolution.entry.input).toBe(9)
  })

  test("without a catalogue, a model the table lacks has no price", () => {
    expect(resolvePrice({ table: bundled }, "anthropic", "claude-zeta-1", none, DAY)).toEqual({ source: "none", listed: false })
  })
})

describe("provider and model identity", () => {
  test("gemini traces are priced from models.dev's google provider", () => {
    const resolution = resolvePrice(sources(), "gemini", "models/gemini-zeta", none, DAY)
    expect(resolution.source === "catalogue" && resolution.catalogue.provider).toBe("google")
  })

  test("another trace provider id is looked up as the models.dev provider of the same id", () => {
    const resolution = resolvePrice(sources(), "deepseek", "deepseek-zeta", none, DAY)
    expect(resolution.source === "catalogue" && resolution.entry.input).toBe(0.27)
    const router = resolvePrice(sources(), "openrouter", "acme/widget-1", none, DAY)
    expect(router.source === "catalogue" && router.entry.input).toBe(0.2)
  })

  test("never uses another provider's price for a same-named model unless mapped", () => {
    expect(resolvePrice(sources(), "anthropic", "widget-1", none, DAY).source).toBe("none")
    expect(resolvePrice(sources(), "openai", "claude-zeta-1", none, DAY).source).toBe("none")
    expect(resolvePrice(sources(), "mystery", "claude-zeta-1", none, DAY).source).toBe("none")
    const mapped = resolvePrice(sources({ catalogueProviders: { anthropic: "openrouter" } }), "anthropic", "acme/widget-1", none, DAY)
    expect(mapped.source === "catalogue" && mapped.catalogue.provider).toBe("openrouter")
  })

  test("a router's vendor/model ids: the full id matches exactly, a bare id only when unambiguous", () => {
    const router = sources({ catalogueProviders: { anthropic: "openrouter" } })
    const full = resolvePrice(router, "anthropic", "anthropic/claude-zeta-1", none, DAY)
    expect(full.source === "catalogue" && full.entry.input).toBe(1.05)
    const prefixed = resolvePrice(router, "anthropic", "openrouter/anthropic/claude-zeta-1", none, DAY)
    expect(prefixed.source === "catalogue" && prefixed.entry.input).toBe(1.05)
    const bare = resolvePrice(router, "anthropic", "claude-zeta-1", none, DAY)
    expect(bare.source === "none" && bare.ambiguous?.map((candidate) => candidate.id)).toEqual(["acme/claude-zeta-1", "anthropic/claude-zeta-1"])
    const dotted = resolvePrice(router, "anthropic", "claude-zeta-1-5", none, DAY)
    expect(dotted.source === "catalogue" && dotted.catalogue.id).toBe("anthropic/claude-zeta-1.5")
  })

  test("a cloud's regional ids keep their own price, and a bare id across regions is ambiguous", () => {
    const bedrock = sources({ catalogueProviders: { anthropic: "amazon-bedrock" } })
    const regional = resolvePrice(bedrock, "anthropic", "us.anthropic.claude-zeta-1", none, DAY)
    expect(regional.source === "catalogue" && regional.entry.input).toBe(1.1)
    expect(resolvePrice(bedrock, "anthropic", "claude-zeta-1", none, DAY).source).toBe("none")
  })

  test("a model the table lists keeps the table's first-party price under a mapping, and is compared with the first-party entry", () => {
    const resolution = resolvePrice(sources({ catalogueProviders: { openai: "openrouter" } }), "openai", "gpt-6-luna", none, DAY)
    expect(resolution.source === "table" && resolution.entry.input).toBe(0.1)
    expect(resolution.source === "table" && resolution.differences).toBeFalsy()
  })

  test("a model the table excludes on purpose gets no catalogue price; one it does not exclude does, whatever its name", () => {
    const excluding = { ...bundled, exclude: [{ provider: "anthropic", names: ["claude-zeta-latest"], reason: "an alias the provider repoints" }] }
    const resolution = resolvePrice(sources({ table: excluding }), "anthropic", "claude-zeta-latest", none, DAY)
    expect(resolution.source === "none" && resolution.excluded?.reason).toBe("an alias the provider repoints")
    expect(resolvePrice(sources(), "anthropic", "claude-zeta-latest", none, DAY).source).toBe("catalogue")
    // The bundled table excludes Google's hot-swapped aliases by name.
    expect(resolvePrice(sources(), "gemini", "gemini-flash-latest", none, DAY)).toMatchObject({ source: "none", excluded: { provider: "gemini" } })
  })

  test("a catalogue-priced model takes its family's cache facts from the table, else the provider's", () => {
    expect(providerFacts(bundled, "openai", undefined, "gpt-5.6-mini").cache_ttl_seconds).toBe(1800)
    expect(providerFacts(bundled, "openai", undefined, "openai/gpt-6.2-nova-2027-01-01").cache_ttl_seconds).toBe(1800)
    expect(providerFacts(bundled, "openai", undefined, "gpt-5.5-mini").cache_ttl_seconds).toBe(300)
    expect(providerFacts(bundled, "openai", undefined, "gpt-60").cache_ttl_seconds).toBe(300)
  })

  test("--catalogue-provider mappings are parsed and checked", () => {
    expect(parseProviderMapping("anthropic=openrouter, openai=openrouter")).toEqual({ anthropic: "openrouter", openai: "openrouter" })
    expect(() => parseProviderMapping("openrouter")).toThrow("expected <trace provider>=<models.dev provider>")
  })
})

describe("cache prices the catalogue does not list", () => {
  const rates = (id: string, call: Usage, params?: Record<string, unknown>) => catalogueRates(entry("anthropic", id), call, params)

  test("no cache-read price: no call is costed, even one that read nothing (its miss cost needs it)", () => {
    expect(rates("claude-zeta-noread", none)).toEqual({ missing: ["cache_read"] })
  })

  test("no cache-write price: calls without writes are costed, calls with writes are not", () => {
    expect(rates("claude-zeta-nowrite", usage(1000, 500, 0)).entry?.cache_write).toBeUndefined()
    expect(rates("claude-zeta-nowrite", usage(1000, 500, null)).missing).toEqual([])
    expect(rates("claude-zeta-nowrite", usage(1000, 500, 200)).missing).toEqual(["cache_write"])
  })

  test("1-hour writes are never costed from the catalogue, which has no 1-hour price", () => {
    expect(rates("claude-zeta-1", { ...usage(1000, 0, 400), cache_write_1h_tokens: 400 }).missing).toEqual(["cache_write_1h"])
  })

  test("a tier that does not list a price the base lists does not borrow the base's", () => {
    expect(rates("claude-zeta-tiergap", usage(1000, 0, 0)).missing).toEqual([])
    expect(rates("claude-zeta-tiergap", usage(150000, 0, 0)).missing).toEqual(["cache_read"])
  })

  test("a separate reasoning price leaves calls that report reasoning tokens uncosted", () => {
    const reasoner = entry("openai", "gpt-zeta-reasoner")
    expect(catalogueRates(reasoner, usage(1000, 0, null)).missing).toEqual([])
    expect(catalogueRates(reasoner, { ...usage(1000, 0, null), reasoning_tokens: 20 }).missing).toEqual(["reasoning"])
  })

  test("modes: matching parameters select the mode's price; a mode without a price is not costed; service tiers are not applied", () => {
    expect(rates("claude-zeta-1", none, { speed: "fast" })).toMatchObject({ mode: "fast", entry: { input: 2 } })
    expect(rates("claude-zeta-1", none, { thinking: { mode: "deep", budget: 3 } })).toEqual({ missing: ["deep_mode"], mode: "deep" })
    expect(catalogueRates(entry("openai", "gpt-zeta"), none, { service_tier: "priority" }).entry?.input).toBe(1)
  })
})

describe("report notes", () => {
  const now = new Date("2026-11-12T12:00:00Z")
  const at = (model: string, call: Usage, provider = "anthropic") => usageRecord(model, call, { provider, ts: "2026-11-12T10:00:00Z" })

  test("a catalogue-priced model is costed and named with its source and dates", () => {
    const analysis = analyze([at("claude-zeta-1", usage(2000, 0, 1000))], { pricing: bundled, catalogue, now })
    expect(analysis.turns[0]!.priced).toBe("catalogue")
    expect(analysis.turns[0]!.cost?.total).toBeCloseTo((2000 * 1 + 1000 * 1.25 + 50 * 5) / 1e6, 12)
    const note = analysis.summary.notes.find((line) => line.startsWith("Priced from the models.dev catalogue"))
    expect(note).toContain("(fetched 2026-11-12), not the hand-verified pricing table: claude-zeta-1 as models.dev anthropic claude-zeta-1, last updated 2026-10-20")
    expect(note).toContain("cache lifetime 300 s and minimum 1,024 tokens are anthropic defaults")
  })

  test("a disagreement is noted with both figures and both dates", () => {
    const analysis = analyze([at("claude-sonnet-5-5", usage(2000, 0, 1000))], { pricing: bundled, catalogue, now })
    expect(analysis.turns[0]!.priced).toBe("table")
    expect(analysis.summary.notes).toContain(
      "Prices differ for claude-sonnet-5-5: the pricing table (checked 2026-11-12) vs models.dev anthropic claude-sonnet-5-5 (last updated 2026-10-01, fetched 2026-11-12): input $2 vs $3 per million tokens. The pricing table's figures are used; check the provider's pricing page.",
    )
  })

  test("a call needing a price the catalogue lacks is unpriced, and the note says which", () => {
    const analysis = analyze([at("claude-zeta-nowrite", usage(2000, 0, 1000))], { pricing: bundled, catalogue, now })
    expect(analysis.turns[0]!.cost).toBeNull()
    expect(analysis.summary.notes).toContain(
      "No price for claude-zeta-nowrite (models.dev lists anthropic claude-zeta-nowrite with no cache-write price, which these calls need; they are not costed rather than priced at a guess): add it to the pricing table to get costs.",
    )
  })

  test("an ambiguous router id is unpriced and its candidates are named", () => {
    const analysis = analyze([at("claude-zeta-1", none)], { pricing: bundled, catalogue, catalogueProviders: { anthropic: "openrouter" }, now })
    expect(analysis.summary.notes.join("\n")).toContain("models.dev openrouter lists acme/claude-zeta-1, anthropic/claude-zeta-1 at different prices; use the full model id")
  })

  test("an old catalogue is called out", () => {
    const analysis = analyze([at("claude-zeta-1", none)], { pricing: bundled, catalogue, now: new Date("2027-03-01T00:00:00Z") })
    expect(analysis.summary.notes).toContain("The models.dev prices were fetched 108 days ago (2026-11-12): run prefixlens pricing update.")
  })
})

describe("comparing sources", () => {
  test("the table against the catalogue: shared ids, ids it lacks, and every disagreement", () => {
    const comparison = compareTables(bundled, catalogue, "2026-11-12")
    expect(comparison.shared).toEqual(["anthropic claude-opus-5-5", "anthropic claude-sonnet-5-5", "anthropic claude-haiku-5-5", "openai gpt-6-luna", "openai gpt-5.6-sol", "openai gpt-5.4", "gemini gemini-2.5-flash"])
    expect(comparison.missing).toContain("anthropic claude-opus-5-5-fast")
    expect(comparison.disagreements.map((item) => [item.model, item.differences])).toEqual([
      ["claude-sonnet-5-5", [{ field: "input", table: 2, catalogue: 3 }]],
      ["claude-haiku-5-5", [{ field: "tier above 100,000", table: 0.5 }]],
    ])
  })

  test("a fetch against the previous one: added, removed and changed prices", () => {
    const next = structuredClone(raw)
    next.deepseek.models["deepseek-zeta"].cost.input = 0.3
    delete next.openai.models["gpt-zeta"]
    next.openai.models["gpt-zeta-2"] = { cost: { input: 1, output: 2, cache_read: 0.1 } }
    const changes = compareCatalogues(catalogue, convertCatalogue(next, "next"))
    expect(changes.added.map((item) => item.id)).toEqual(["gpt-zeta-2"])
    expect(changes.removed.map((item) => item.id)).toEqual(["gpt-zeta"])
    expect(changes.changed.map((item) => [item.after.id, item.differences])).toEqual([["deepseek-zeta", [{ field: "input", table: 0.27, catalogue: 0.3 }]]])
    expect(compareCatalogues(undefined, catalogue).added).toEqual([])
  })
})

describe("fetching", () => {
  const serve = (handler: (request: Request) => Response | Promise<Response>) => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })

  test("sends one plain GET: no body, no cookies or credentials", async () => {
    const seen: { method: string; headers: Record<string, string>; body: string }[] = []
    const server = serve(async (request) => {
      seen.push({ method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() })
      return Response.json(raw)
    })
    const value = await fetchCatalogue({ url: `http://127.0.0.1:${server.port}/api.json` })
    server.stop(true)
    expect(convertCatalogue(value, "served").models.length).toBe(catalogue.models.length)
    expect(seen.length).toBe(1)
    expect(seen[0]!.method).toBe("GET")
    expect(seen[0]!.body).toBe("")
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(["accept", "accept-encoding", "connection", "host", "user-agent"])
    expect(seen[0]!.headers["user-agent"]).toMatch(/^Bun\//)
  })

  test("an HTTP error, a redirect, an oversized response and a hung server each fail with a message", async () => {
    const server = serve((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/error") return new Response("down", { status: 503 })
      if (url.pathname === "/redirect") return Response.redirect("http://127.0.0.1:1/elsewhere", 302)
      if (url.pathname === "/declared") return new Response("x".repeat(2048))
      if (url.pathname === "/streamed")
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(512)))
            },
          }),
        )
      return new Promise<Response>(() => {})
    })
    const base = `http://127.0.0.1:${server.port}`
    expect(fetchCatalogue({ url: `${base}/error` })).rejects.toThrow("answered HTTP 503")
    expect(fetchCatalogue({ url: `${base}/redirect` })).rejects.toThrow("answered HTTP 302")
    expect(fetchCatalogue({ url: `${base}/declared`, maxBytes: 1024 })).rejects.toThrow("more than the 0.0 MB limit")
    expect(fetchCatalogue({ url: `${base}/streamed`, maxBytes: 4096 })).rejects.toThrow("sent more than the 0.0 MB limit")
    expect(fetchCatalogue({ url: `${base}/hang`, timeoutMs: 200 })).rejects.toThrow("did not answer within 0.2 s; use --from <file> to read a saved copy")
    await Bun.sleep(300)
    server.stop(true)
  })

  test("offline: a refused connection says so and points at --from", async () => {
    const server = serve(() => new Response(""))
    const port = server.port
    server.stop(true)
    expect(fetchCatalogue({ url: `http://127.0.0.1:${port}/api.json` })).rejects.toThrow(/could not fetch .* \(offline\?\): .*; use --from <file> to read a saved copy/)
  })

  test("a local file is read with the same size limit", async () => {
    expect(convertCatalogue(await readCatalogueFile(fixture), fixture).models.length).toBe(catalogue.models.length)
    expect(readCatalogueFile(fixture, 100)).rejects.toThrow("more than the 0.0 MB limit")
    expect(readCatalogueFile(path.join(temp, "nope.json"))).rejects.toThrow("catalogue file not found")
    const broken = path.join(temp, "broken.json")
    await Bun.write(broken, "{")
    expect(readCatalogueFile(broken)).rejects.toThrow("is not valid JSON")
  })

  // Run with PREFIXLENS_LIVE_CATALOGUE=1. Fetches the real catalogue once and compares the bundled table with it.
  test.skipIf(!process.env.PREFIXLENS_LIVE_CATALOGUE)(
    "live: the real catalogue converts and shares models with the bundled table",
    async () => {
      const live = convertCatalogue(await fetchCatalogue(), CATALOGUE_URL)
      const comparison = compareTables(bundled, live, new Date().toISOString().slice(0, 10))
      console.log(`live models.dev: ${live.models.length} priced models; ${comparison.shared.length} bundled ids shared; ${comparison.disagreements.length} disagreements`)
      for (const item of comparison.disagreements) console.log(`  ${item.provider} ${item.model}: ${JSON.stringify(item.differences)}`)
      expect(live.models.length).toBeGreaterThan(1000)
      expect(comparison.shared.length).toBeGreaterThan(30)
    },
    60_000,
  )
})
