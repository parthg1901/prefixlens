// scripts/release-check.mjs: what the release workflow runs before it publishes.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { root, tempDir } from "./helpers.mjs"

function check(dir, tag) {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "release-check.mjs"), tag, path.join(dir, "notes.md")], { encoding: "utf8" })
  return { code: result.status, stderr: result.stderr }
}

function copy(t, edit) {
  const dir = tempDir(t, "release")
  mkdirSync(path.join(dir, "scripts"))
  cpSync(path.join(root, "scripts", "release-check.mjs"), path.join(dir, "scripts", "release-check.mjs"))
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(edit(pkg)))
  cpSync(path.join(root, "CHANGELOG.md"), path.join(dir, "CHANGELOG.md"))
  return { dir, version: pkg.version }
}

test("refuses to release while package.json is private", (t) => {
  const { dir, version } = copy(t, (pkg) => ({ ...pkg, private: true }))
  const result = check(dir, `v${version}`)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /"private": true/)
})

test("refuses a tag that is not the package version, and a version the changelog has no section for", (t) => {
  const { dir, version } = copy(t, ({ private: _, ...pkg }) => pkg)
  assert.match(check(dir, "v9.9.9").stderr, new RegExp(`does not match the package.json version ${version.replaceAll(".", "\\.")}`))
  const unlisted = copy(t, ({ private: _, ...pkg }) => ({ ...pkg, version: "9.9.9" }))
  assert.match(check(unlisted.dir, "v9.9.9").stderr, /CHANGELOG\.md has no "## \[9\.9\.9\]" section/)
})

test("writes the version's changelog section as the release notes", (t) => {
  const { dir, version } = copy(t, ({ private: _, ...pkg }) => pkg)
  const result = check(dir, `v${version}`)
  assert.equal(result.code, 0, result.stderr)
  const notes = readFileSync(path.join(dir, "notes.md"), "utf8")
  assert.match(notes, /^### Added$/m)
  assert.doesNotMatch(notes, /^## \[/m)
})
