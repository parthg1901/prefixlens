import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Plain Node runs .ts files by stripping types and rejects syntax that needs generated code
// (parameter properties, enums, namespaces). The sources must stay importable that way, since a
// harness may vendor them into its own tests; `erasableSyntaxOnly` in tsconfig.json enforces it at
// type-check time, and this imports the entry points under Node itself.
const node = Bun.which("node")
const version = node ? Bun.spawnSync([node, "--version"]).stdout.toString().trim() : ""
const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number)
// Type stripping is on by default from Node 22.18 and 23.6.
const strips = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)

function exportsUnderNode(file: string) {
  const url = pathToFileURL(path.join(import.meta.dir, "..", "src", file)).href
  const child = Bun.spawnSync([node!, "--input-type=module", "--eval", `console.log(Object.keys(await import(${JSON.stringify(url)})).join(","))`], { stdout: "pipe", stderr: "pipe" })
  return { exitCode: child.exitCode, names: child.stdout.toString().trim().split(","), stderr: child.stderr.toString() }
}

describe.skipIf(!strips)(`the TypeScript sources under plain Node (${version || "node not found"})`, () => {
  test("prefixlens/test loads from src/assert.ts", () => {
    const loaded = exportsUnderNode("assert.ts")
    expect(loaded.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX")
    expect(loaded.exitCode).toBe(0)
    expect(loaded.names).toEqual(expect.arrayContaining(["assertPrefixStable", "explainPrefixDiff", "PrefixBreakError"]))
  })

  test("the main entry point loads from src/index.ts, proxy and importers included", () => {
    const loaded = exportsUnderNode("index.ts")
    expect(loaded.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX")
    expect(loaded.exitCode).toBe(0)
    expect(loaded.names).toEqual(expect.arrayContaining(["analyze", "startProxy", "findAdapter"]))
  })
})

describe("tsconfig.json", () => {
  test("rejects syntax that cannot be erased, so a parameter property cannot come back", async () => {
    const config = await Bun.file(path.join(import.meta.dir, "..", "tsconfig.json")).json()
    expect(config.compilerOptions.erasableSyntaxOnly).toBe(true)
  })
})
