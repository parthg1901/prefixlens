// The checks a release runs before it publishes, runnable locally:
//
//   node scripts/release-check.mjs v0.5.0 [notes.md]
//
// Fails while package.json has "private": true (so a stray tag cannot publish), when the tag is not
// "v" + the package.json version, when CHANGELOG.md has no section for that version, or when its
// "## [Unreleased]" section still has entries (the tagged code would then hold changes the release
// notes leave out). Otherwise writes the version's section (without its heading) to the notes file,
// for the GitHub release.

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const [tag, notesFile] = process.argv.slice(2)
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const fail = (message) => {
  // GitHub Actions shows ::error:: lines as annotations; elsewhere they read as plain errors.
  console.error(`::error::${message}`)
  process.exit(1)
}

if (!tag) fail("usage: node scripts/release-check.mjs <tag> [notes file]")
if (pkg.private === true)
  fail(`package.json has "private": true, so ${tag} is not published. Remove "private" (see docs/releasing.md) and tag again when the release is decided.`)
if (tag !== `v${pkg.version}`) fail(`the tag ${tag} does not match the package.json version ${pkg.version} (expected v${pkg.version})`)
const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8")
const notes = changelogSection(changelog, pkg.version)
if (notes === undefined) fail(`CHANGELOG.md has no "## [${pkg.version}]" section`)
if (notes.trim() === "") fail(`CHANGELOG.md's section for ${pkg.version} is empty`)
if ((changelogSection(changelog, "Unreleased") ?? "").trim() !== "")
  fail(`CHANGELOG.md has entries under "## [Unreleased]" that ${tag} would publish without release notes. Move them into the "## [${pkg.version}]" section, or release them as the next version.`)
if (notesFile) writeFileSync(notesFile, `${notes.trim()}\n`)
console.log(`release ${tag}: package.json version ${pkg.version}, not private, CHANGELOG.md section of ${notes.trim().split("\n").length} lines`)

// The text between "## [version]" (with or without a date) and the next "## " heading or link definitions.
function changelogSection(text, version) {
  const lines = text.split("\n")
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const start = lines.findIndex((line) => new RegExp(`^## \\[${escaped}\\](\\s|$)`).test(line))
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line) || /^\[[^\]]+\]: /.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join("\n")
}
