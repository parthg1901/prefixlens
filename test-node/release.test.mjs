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

// The repository's changelog as it is at a release: nothing under "## [Unreleased]". Between releases
// that section holds entries, which the check refuses, so they are left out of the copy.
const released = (changelog) => changelog.replace(/^(## \[Unreleased\][^\n]*\n)[\s\S]*?(?=^## )/m, "$1\n")

function copy(t, edit, changelog = released) {
  const dir = tempDir(t, "release")
  mkdirSync(path.join(dir, "scripts"))
  cpSync(path.join(root, "scripts", "release-check.mjs"), path.join(dir, "scripts", "release-check.mjs"))
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(edit(pkg)))
  writeFileSync(path.join(dir, "CHANGELOG.md"), changelog(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")))
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
  // The section's own subsections and entries, and nothing of the sections around it.
  assert.match(notes, /^### (Added|Changed|Fixed|Removed|Deprecated|Security|Breaking changes)$/m)
  assert.match(notes, /^- /m)
  assert.doesNotMatch(notes, /^## /m)
  assert.doesNotMatch(notes, /^#{1,3} \[?\d+\.\d+\.\d+/m)
  assert.doesNotMatch(notes, /^\[[^\]]+\]: /m)
})

test("the notes end where the next section starts, whatever its heading", (t) => {
  const changelog = () => ["# Changelog", "", "## [Unreleased]", "", "## [9.9.9] - 2026-01-01", "", "### Added", "", "- A synthetic entry.", "", "## Before the first release", "", "### 9.9.8 - 2026-01-01", "", "- An older entry.", "", "[9.9.9]: https://example.invalid/v9.9.9", ""].join("\n")
  const { dir } = copy(t, ({ private: _, ...pkg }) => ({ ...pkg, version: "9.9.9" }), changelog)
  const result = check(dir, "v9.9.9")
  assert.equal(result.code, 0, result.stderr)
  assert.equal(readFileSync(path.join(dir, "notes.md"), "utf8"), "### Added\n\n- A synthetic entry.\n")
})

test("refuses to release while the changelog has entries under Unreleased", (t) => {
  const withEntry = (changelog) => released(changelog).replace(/^## \[Unreleased\][^\n]*\n/m, "$&\n### Fixed\n\n- A synthetic fix that no release notes would mention.\n")
  const { dir, version } = copy(t, ({ private: _, ...pkg }) => pkg, withEntry)
  const result = check(dir, `v${version}`)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /entries under "## \[Unreleased\]"/)
  // A changelog with no Unreleased section at all has nothing unreleased in it.
  const without = copy(t, ({ private: _, ...pkg }) => pkg, (changelog) => released(changelog).replace(/^## \[Unreleased\][^\n]*\n/m, ""))
  assert.equal(check(without.dir, `v${version}`).code, 0)
})
