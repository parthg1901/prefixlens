import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { serializeTrace } from "../src/trace.ts"
import { usage, usageRecord } from "./helpers.ts"

const root = path.join(import.meta.dir, "..")
const fixture = path.join(import.meta.dir, "fixtures", "catalogue", "api.json")
const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-pricing-cli-"))
const cache = path.join(temp, "cache")
const overlay = path.join(cache, "prefixlens", "models.dev.json")
afterAll(() => rmSync(temp, { recursive: true, force: true }))

function run(args: string[]) {
  const result = Bun.spawnSync(["bun", path.join(root, "src/cli.ts"), ...args], {
    cwd: temp,
    env: { ...process.env, NO_COLOR: "1", PREFIXLENS_PRICING: "", XDG_CACHE_HOME: cache },
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

async function trace(name: string, model: string, provider = "anthropic") {
  const file = path.join(temp, `${name}.trace.jsonl`)
  await Bun.write(file, serializeTrace([usageRecord(model, usage(4000, 0, 2000), { provider, ts: "2026-11-12T10:00:00Z" })]))
  return file
}

describe("prefixlens pricing", () => {
  test("show before any update: the table's price, and no catalogue", () => {
    const result = run(["pricing", "show", "claude-opus-5-5", "--date", "2026-11-12"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("source       the bundled pricing.json, checked 2026-11-12 (anthropic entry)")
    expect(result.stdout).toContain("models.dev   not fetched (prefixlens pricing update)")
  })

  test("update --from converts a saved catalogue, writes it to the cache, and reports disagreements", async () => {
    const result = run(["pricing", "update", "--from", fixture])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`wrote ${overlay}`)
    expect(result.stdout).toContain("MIT licence, Copyright (c) 2025 models.dev")
    expect(result.stdout).toContain("no earlier fetch to compare with")
    expect(result.stdout).toContain("compared with the bundled pricing.json (as of 2026-11-12): 7 model ids in both")
    expect(result.stdout).toContain("! anthropic claude-sonnet-5-5: input $2 vs $3 (table checked 2026-11-12; models.dev anthropic claude-sonnet-5-5, last updated 2026-10-01, fetched ")
    expect((await Bun.file(overlay).json()).source.licence).toBe("MIT")
    // Public data, but owner-only like every file prefixlens creates, in an owner-only directory it created.
    expect(statSync(overlay).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(overlay)).mode & 0o777).toBe(0o700)
  })

  test("a second update lists what changed since the first", async () => {
    const next = await Bun.file(fixture).json()
    next.deepseek.models["deepseek-zeta"].cost.input = 0.3
    next.openai.models["gpt-zeta-2"] = { cost: { input: 1, output: 2, cache_read: 0.1 } }
    const file = path.join(temp, "next.json")
    await Bun.write(file, JSON.stringify(next))
    const result = run(["pricing", "update", "--from", file])
    expect(result.stdout).toMatch(/since the fetch of \d{4}-\d{2}-\d{2}: 1 model added, 0 removed, 1 price changed/)
    expect(result.stdout).toContain("  + openai gpt-zeta-2  input $1 · cache read $0.1 · cache write not listed · output $2")
    expect(result.stdout).toContain("  ~ deepseek deepseek-zeta: input $0.27 -> $0.3")
    run(["pricing", "update", "--from", fixture])
  })

  test("check exits 1 with every disagreement, for a scheduled job", () => {
    const result = run(["pricing", "check", "--from", fixture])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("2 disagreements")
    expect(result.stdout).toContain("! anthropic claude-haiku-5-5: tier above 100,000 $0.5 vs none")
    const json = JSON.parse(run(["pricing", "check", "--from", fixture, "--json"]).stdout)
    expect(json.shared).toBe(7)
    expect(json.disagreements.map((item: { model: string }) => item.model)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"])
  })

  test("check exits 0 when the sources agree", async () => {
    const table = path.join(temp, "agrees.json")
    await Bun.write(table, JSON.stringify({ as_of: "2026-11-12", models: [{ provider: "openai", names: ["gpt-zeta"], input: 1, output: 4, cache_read: 0.1 }] }))
    const result = run(["pricing", "check", "--from", fixture, "--pricing", table])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`compared with the pricing table ${table} (as of 2026-11-12): 1 model id in both, 0 not in models.dev under the same provider, 0 disagreements`)
  })

  test("show: a catalogue price, a disagreement, a missing price and an unknown model", () => {
    const zeta = run(["pricing", "show", "claude-zeta-1"]).stdout
    expect(zeta).toMatch(/source {7}models\.dev anthropic claude-zeta-1 \(last updated 2026-10-20, fetched \d{4}-\d{2}-\d{2}\): community-maintained, not hand-verified/)
    expect(zeta).toContain("1 hour and 12 hours: not in models.dev, calls with such writes are not costed")
    expect(zeta).toContain("cache        lifetime 300 s, minimum 1,024 tokens (provider defaults: models.dev has neither)")
    expect(run(["pricing", "show", "claude-sonnet-5-5"]).stdout).toContain("DISAGREES: input $2 vs $3; the pricing table's figures are used")
    expect(run(["pricing", "show", "claude-zeta-noread"]).stdout).toContain("cache read   not listed: calls with this model are not costed")
    expect(run(["pricing", "show", "widget-1", "--provider", "anthropic"]).stdout).toContain(
      "no price: not in the bundled pricing.json, and models.dev anthropic has no widget-1 (other providers' prices are used only with --catalogue-provider)",
    )
    expect(run(["pricing", "show", "acme/widget-1", "--provider", "anthropic", "--catalogue-provider", "anthropic=openrouter"]).stdout).toContain("source       models.dev openrouter acme/widget-1")
    expect(run(["pricing", "show", "widget-1"]).stderr).toContain("cannot tell the provider of widget-1; pass --provider")
    expect(run(["pricing", "show", "gpt-5.6-sol", "--date", "2026-12-05"]).stdout).toContain("the catalogue is not used for a model it lists")
  })

  test("report prices a model the table lacks from the catalogue and says so; --no-catalogue turns it off", async () => {
    const file = await trace("zeta", "claude-zeta-1")
    const result = run(["report", file])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("$0.0068 at API list prices")
    expect(result.stdout).toContain("note: Priced from the models.dev catalogue (fetched ")
    expect(result.stdout).toContain("then models.dev (fetched ")
    const json = JSON.parse(run(["report", file, "--json"]).stdout)
    expect(json.turns[0].priced).toBe("catalogue")
    expect(json.pricing.catalogue.source).toBe("models.dev")
    expect(run(["report", file, "--no-catalogue"]).stdout).toContain("No price for claude-zeta-1: add it to the pricing table to get costs.")
  })

  test("report notes a disagreement for a model the table prices", async () => {
    const result = run(["report", await trace("sonnet", "claude-sonnet-5-5")])
    expect(result.stdout).toContain("note: Prices differ for claude-sonnet-5-5: the pricing table (checked 2026-11-12) vs models.dev anthropic claude-sonnet-5-5")
  })

  test("a broken overlay is ignored with a warning, not a failed report", async () => {
    await Bun.write(overlay, "{")
    const result = run(["report", await trace("broken", "claude-opus-5-5")])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("warning: not using the models.dev prices:")
    rmSync(overlay)
  })

  test("usage errors", () => {
    expect(run(["pricing"]).stderr).toContain("usage: prefixlens pricing update | check | show <model>")
    expect(run(["pricing", "update", "--from", path.join(temp, "missing.json")]).stderr).toContain("catalogue file not found")
    expect(run(["pricing", "show", "claude-opus-5-5", "--date", "tomorrow"]).stderr).toContain("--date must be YYYY-MM-DD")
    expect(run(["pricing", "show", "claude-opus-5-5", "--catalogue-provider", "openrouter"]).stderr).toContain("expected <trace provider>=<models.dev provider>")
  })
})
