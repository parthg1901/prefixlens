import { describe, expect, test } from "bun:test"
import path from "node:path"
import { analyze } from "../src/analyze.ts"
import { paramRule } from "../src/params.ts"
import { parsePricing } from "../src/pricing.ts"
import { parseTrace, TRACE_FORMAT_VERSION } from "../src/trace.ts"
import { TEST_PRICING } from "./helpers.ts"

// SPEC.md is what other implementations build from, so its example must stay a valid trace.
const spec = await Bun.file(path.join(import.meta.dir, "..", "SPEC.md")).text()

describe("SPEC.md version", () => {
  test("the title, the record table and the code name the same format version", () => {
    expect(spec.match(/^# prefixlens trace format, version (\d+\.\d+)$/m)?.[1]).toBe(TRACE_FORMAT_VERSION)
    expect(spec).toContain(`Always \`1\` for this document (${TRACE_FORMAT_VERSION});`)
    // Each earlier minor version is named as still valid, and the newest has its paragraph of additions.
    expect(spec).toContain(`is a valid ${TRACE_FORMAT_VERSION} trace`)
    expect(spec).toContain(`Version ${TRACE_FORMAT_VERSION} adds`)
  })
})

describe("SPEC.md example", () => {
  test("the JSONL example parses with matching hashes and reports the stated cause", () => {
    const example = spec.match(/```jsonl\n([\s\S]*?)```/)![1]!
    const parsed = parseTrace(example)
    expect(parsed.errors).toEqual([])
    expect(parsed.warnings).toEqual([])
    const turns = analyze(parsed.records, { pricing: parsePricing(TEST_PRICING) }).turns
    expect(turns.map((turn) => turn.status)).toEqual(["cold", "hit", "miss"])
    expect(turns[2]!.cause?.summary).toBe("tool list changed (+1 tool: 1 → 2)")
  })

  test("the usage-only example is a valid record", () => {
    const record = spec.match(/A usage-only record needs only the required fields:\n\n```json\n([\s\S]*?)```/)![1]!
    expect(parseTrace(record).errors).toEqual([])
  })
})

describe("SPEC.md section 8.1", () => {
  test("the parameter table says what the code does", () => {
    const section = spec.slice(spec.indexOf("### 8.1"), spec.indexOf("## 9."))
    const rows = section.split("\n").filter((line) => /^\| (all|anthropic|openai) \|/.test(line))
    expect(rows.length).toBeGreaterThan(8)
    for (const row of rows) {
      const [provider, keys, cached] = row.split("|").slice(1, 4).map((cell) => cell.trim())
      // Only the backticked names before any parenthesis are parameters; "(effort)" names a field inside one.
      const names = [...keys!.replace(/\([^)]*\)/g, "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!)
      const effect = cached!.replace(/\*/g, "").startsWith("yes") ? "prefix" : "none"
      for (const target of provider === "all" ? ["anthropic", "openai", "gemini", "other-gateway"] : [provider!])
        for (const name of names) expect({ target, name, effect: paramRule(target, name).effect }).toEqual({ target, name, effect })
    }
  })
})
