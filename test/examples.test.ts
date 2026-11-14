// The example projects run, and the examples in docs/assertions.md are those files word for word.

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const sessions = path.join(root, "examples", "framework-session-test")

describe("examples/framework-session-test", () => {
  test("its tests pass", () => {
    const result = Bun.spawnSync(["bun", "test"], { cwd: sessions, env: { ...process.env, NO_COLOR: "1" } })
    expect(result.stderr.toString()).toContain(" 4 pass")
    expect(result.exitCode).toBe(0)
  })

  test("docs/assertions.md shows each test file in full", () => {
    const doc = readFileSync(path.join(root, "docs", "assertions.md"), "utf8")
    const files = readdirSync(sessions).filter((name) => name.endsWith(".test.ts"))
    expect(files).toHaveLength(4)
    for (const name of files) expect(doc).toContain(`\`\`\`ts\n${readFileSync(path.join(sessions, name), "utf8").trimEnd()}\n\`\`\``)
  })
})

describe("examples/ci-prefix-test", () => {
  test("its tests pass", () => {
    const result = Bun.spawnSync(["bun", "test"], { cwd: path.join(root, "examples", "ci-prefix-test"), env: { ...process.env, NO_COLOR: "1" } })
    expect(result.exitCode).toBe(0)
  })
})
