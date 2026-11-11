// Run with `bun test`. Each test builds two consecutive requests the way the
// harness would and checks that the second keeps the first one's cached prefix.

import { describe, expect, test } from "bun:test"
import { assertPrefixStable, explainPrefixDiff } from "prefixlens/test"
import { buildRequest, type Turn } from "./agent.ts"

const first: Turn[] = [{ role: "user", text: "Fix the failing test." }]
const second: Turn[] = [...first, { role: "assistant", text: "Looking at it. " }, { role: "user", text: "Go ahead." }]

test("the harness appends to its prefix", () => {
  assertPrefixStable(buildRequest(first), buildRequest(second))
})

test("a compaction may replace history, but the tools and instructions must survive", () => {
  const compacted: Turn[] = [{ role: "user", text: "Summary: the test fails on a missing import." }]
  assertPrefixStable(buildRequest(second), buildRequest(compacted), { allowBreak: { after: "system", reason: "compaction" } })
})

test("forbidding tools on the last step keeps the prefix (OpenAI does not cache on tool_choice)", () => {
  assertPrefixStable(buildRequest(first), buildRequest(second, { finalStep: true }))
})

test("a revert may drop messages, but must keep the tools and instructions", () => {
  const reverted: Turn[] = [first[0]!, { role: "assistant", text: "Let me start over." }]
  assertPrefixStable(buildRequest(second), buildRequest(reverted), { allowBreak: "revert" })
  const result = explainPrefixDiff(buildRequest(second), buildRequest(reverted, { mode: "plan" }), { allowBreak: "revert" })
  expect(result.ok).toBe(false)
  expect(result.message).toContain("a break was allowed (revert) only after block 4")
})

// The four common bugs. Each test shows the message prefixlens fails with;
// in your own suite you would call assertPrefixStable and let it throw.
describe("common bugs prefixlens catches", () => {
  test("tools sorted differently each turn", () => {
    const result = explainPrefixDiff(buildRequest(first, { shuffleTools: true }), buildRequest(second, { shuffleTools: true }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain("tool order changed")
  })

  test("a timestamp in the system prompt", () => {
    const result = explainPrefixDiff(
      buildRequest(first, { now: new Date("2026-01-01T10:41:00Z") }),
      buildRequest(second, { now: new Date("2026-01-01T10:42:00Z") }),
    )
    expect(result.message).toContain("system prompt changed: a timestamp value was updated")
  })

  test("rewriting an already-sent message", () => {
    const third: Turn[] = [...second, { role: "assistant", text: "Done." }, { role: "user", text: "Thanks." }]
    const result = explainPrefixDiff(buildRequest(second, { tidyHistory: true }), buildRequest(third, { tidyHistory: true }))
    expect(result.message).toContain("message #2 (assistant) was edited after it was sent")
  })

  test("the tool list changing on a mode switch", () => {
    const result = explainPrefixDiff(buildRequest(first, { mode: "build" }), buildRequest(second, { mode: "plan" }))
    expect(result.message).toContain("tool list changed (-2 tools: 3 → 1)")
  })
})

// Uncomment to see a real failure:
// test("fails", () => assertPrefixStable(buildRequest(first, { shuffleTools: true }), buildRequest(second, { shuffleTools: true })))
