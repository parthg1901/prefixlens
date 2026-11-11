import { describe, expect, test } from "bun:test"
import { diffLines, excerpt, flatten, renderDiff } from "../src/textdiff.ts"

describe("textdiff", () => {
  test("flatten renders paths and breaks multi-line strings", () => {
    expect(flatten({ role: "user", content: [{ type: "text", text: "a\nb" }], n: 1, e: [] })).toEqual([
      "role: user",
      "content[0].type: text",
      "content[0].text: |",
      "  a",
      "  b",
      "n: 1",
      "e: []",
    ])
  })

  test("diffLines finds the minimal edit", () => {
    expect(diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"])).toEqual([
      { op: "same", line: "a" },
      { op: "del", line: "b" },
      { op: "add", line: "x" },
      { op: "same", line: "c" },
      { op: "same", line: "d" },
      { op: "add", line: "e" },
    ])
  })

  test("renderDiff shows changes with context and elides the rest", () => {
    const before = { text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") }
    const after = { text: before.text.replace("line 10", "line ten") }
    expect(renderDiff(before, after)).toBe(["    line 8", "    line 9", "-   line 10", "+   line ten", "    line 11", "    line 12"].join("\n"))
  })

  test("renderDiff caps output length", () => {
    const before = { list: Array.from({ length: 60 }, (_, index) => index) }
    const after = { list: Array.from({ length: 60 }, (_, index) => index + 1000) }
    const lines = renderDiff(before, after, { maxLines: 10 }).split("\n")
    expect(lines).toHaveLength(11)
    expect(lines[10]).toMatch(/more changed lines/)
  })

  test("long edited lines are cut to a window around the change", () => {
    const base = "x".repeat(500)
    const [a, b] = excerpt(`${base}OLD${base}`, `${base}NEW${base}`, 80)
    expect(a).toContain("OLD")
    expect(b).toContain("NEW")
    expect(a.length).toBeLessThan(100)
    expect(a.startsWith("…")).toBe(true)
  })

  test("identical values render no diff", () => {
    expect(renderDiff({ a: 1 }, { a: 1 })).toBe("")
  })
})
