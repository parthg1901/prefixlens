// Codex rollouts log a hash per tool definition (world_state.state.top_level_tools),
// so a usage-only Codex trace can still name a tool-list change as the likely cause.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { findAdapter } from "../src/adapters/index.ts"
import { analyze } from "../src/analyze.ts"
import { parsePricing } from "../src/pricing.ts"
import { TEST_PRICING } from "./helpers.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "prefixlens-codex-tools-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const THREAD = "00000000-0000-4000-8000-00000000c0d7"
const hash = (seed: string) => seed.repeat(40).slice(0, 40)
let clock = Date.parse("2026-01-01T10:00:00Z")
const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: new Date((clock += 1000)).toISOString(), type, payload })
const worldState = (full: boolean, state: Record<string, unknown>) => line("world_state", { full, state })
const usage = (id: string, input: number, cached: number) =>
  line("token_usage_record", { response_id: id, session_id: THREAD, thread_id: THREAD, usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: input + 10 } })

async function importLines(lines: string[]) {
  const file = path.join(temp, `rollout-2026-01-01T10-00-00-${THREAD}-${lines.length}.jsonl`)
  writeFileSync(file, [line("session_meta", { id: THREAD, session_id: THREAD, cli_version: "0.999.0", model_provider: "openai" }), line("turn_context", { model: "gpt-test-1" }), ...lines].join("\n"))
  return (await findAdapter("codex")!.import(file, {})).records
}

describe("codex tool-list changes", () => {
  test("a changed tool map between two calls becomes a tools_changed hint, and names the miss", async () => {
    const records = await importLines([
      worldState(true, { model: "gpt-test-1", top_level_tools: { exec: hash("a"), shell: hash("b") } }),
      usage("resp_1", 20_000, 0),
      worldState(false, { permissions: {} }),
      usage("resp_2", 21_000, 19_968),
      worldState(false, { top_level_tools: { exec: hash("a"), shell: hash("c"), web_search: hash("d") } }),
      usage("resp_3", 22_000, 0),
    ])
    expect(records.map((record) => record.hints)).toEqual([undefined, undefined, [{ kind: "tools_changed", detail: "+1 tool (web_search), 1 definition changed (shell); 2 → 3 tools" }]])
    const turn = analyze(records, { pricing: parsePricing(TEST_PRICING) }).turns[2]!
    expect(turn.status).toBe("miss")
    expect(turn.cause).toMatchObject({ cause: "tools_changed", group: "tool-list changes", confidence: "inferred" })
    expect(turn.cause!.summary).toContain("tool list changed before this call (harness log: +1 tool (web_search)")
  })

  test("no hint when the map is unchanged, when tools were removed it says so, and nothing before the first call", async () => {
    const records = await importLines([
      worldState(true, { top_level_tools: { exec: hash("a") } }),
      worldState(false, { top_level_tools: { exec: hash("a"), shell: hash("b") } }),
      usage("resp_1", 20_000, 0),
      worldState(true, { top_level_tools: { shell: hash("b"), exec: hash("a") } }),
      usage("resp_2", 21_000, 19_968),
      worldState(false, { top_level_tools: { exec: hash("a") } }),
      usage("resp_3", 22_000, 0),
    ])
    expect(records.map((record) => record.hints?.map((hint) => hint.detail))).toEqual([undefined, undefined, ["-1 tool (shell); 2 → 1 tools"]])
  })

  test("a full snapshot without tools forgets them, so the next map is not compared with an older one", async () => {
    const records = await importLines([
      worldState(true, { top_level_tools: { exec: hash("a") } }),
      usage("resp_1", 20_000, 0),
      worldState(true, { model: "gpt-test-1" }),
      worldState(false, { top_level_tools: { shell: hash("b") } }),
      usage("resp_2", 21_000, 0),
    ])
    expect(records[1]!.hints).toBeUndefined()
  })
})
