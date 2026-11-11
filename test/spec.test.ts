import { describe, expect, test } from "bun:test"
import path from "node:path"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { parseTrace } from "../src/trace.ts"
import { TEST_PRICING } from "./helpers.ts"

// SPEC.md is what other implementations build from, so its example must stay a valid trace.
const spec = await Bun.file(path.join(import.meta.dir, "..", "SPEC.md")).text()

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
