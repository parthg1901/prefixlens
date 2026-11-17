// The landing page (site/): built from the package's own command line, so it runs after the build like the other
// tests here. It checks that the page shows what prefixlens prints and that the instructions for a coding agent are
// whole.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const out = mkdtempSync(path.join(tmpdir(), "prefixlens-site-test-"))
after(() => rmSync(out, { recursive: true, force: true }))

const built = spawnSync(process.execPath, [path.join(root, "site", "build.mjs"), out], { encoding: "utf8" })
const page = built.status === 0 ? readFileSync(path.join(out, "index.html"), "utf8") : ""
const prompt = built.status === 0 ? readFileSync(path.join(out, "agent.md"), "utf8") : ""
const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")

test("the site builds, with every placeholder filled", () => {
  assert.equal(built.status, 0, built.stderr)
  assert.deepEqual(readdirSync(out).sort(), ["_headers", "agent.md", "favicon.svg", "index.html", "og.png", "report.html", "robots.txt"])
  assert.doesNotMatch(page, /\{\{[a-z_]+\}\}/)
  assert.doesNotMatch(prompt, /\{\{[a-z_]+\}\}/)
})

test("the committed page, site/public, is what the build gives now", () => {
  // The host serves site/public as it is committed. When this fails: run `node site/build.mjs` and commit the result.
  const committed = path.join(root, "site", "public")
  // The report states when it was generated, which no two builds share.
  const same = (name) => readFileSync(path.join(committed, name), "utf8").replace(/ · generated [^<]*/, "")
  assert.deepEqual(readdirSync(committed).sort(), readdirSync(out).sort())
  for (const name of readdirSync(out)) {
    const fresh = readFileSync(path.join(out, name), "utf8").replace(/ · generated [^<]*/, "")
    assert.equal(same(name), fresh, `site/public/${name} is out of date: run node site/build.mjs and commit the result`)
  }
})

test("the page shows what prefixlens check prints for the sample session, and its ledger has one row per call", () => {
  const check = spawnSync(process.execPath, [path.join(root, "dist", "cli.js"), "check", path.join(root, "test", "fixtures", "agent-session.jsonl")], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
  assert.equal(check.status, 1)
  const shown = text(page)
  for (const line of check.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("prefixlens check:"))) assert.ok(shown.includes(line), `the page lacks the line: ${line}`)
  assert.equal([...page.matchAll(/<li class="row row--/g)].length, 5)
  assert.equal([...page.matchAll(/<li class="row row--miss"/g)].length, 1)
})

test("the copy button copies the instructions exactly as agent.md has them, naming this version", () => {
  const sheet = /<pre class="sheet__body" id="prompt"[^>]*>([\s\S]*?)<\/pre>/.exec(page)
  assert.ok(sheet, "the page has no instructions")
  assert.equal(text(sheet[1]), prompt.replace(/\n$/, ""))
  assert.ok(prompt.includes(`at exactly version ${version}`))
  assert.doesNotMatch(prompt, /\^\d/, "the instructions give a version range")
  for (const part of ["assertPrefixStable", "recordRequests", "session.assertStable()", "allowBreakAt", "## 1. Understand the harness", "## 7. Report"]) assert.ok(prompt.includes(part), `the instructions lack ${part}`)
})

test("each recipe is on the page as its file has it", () => {
  const shown = text(page)
  for (const file of ["own.ts", "ai-sdk.ts", "mastra.ts", "proxy.sh", "mastra-output.txt"]) {
    const recipe = readFileSync(path.join(root, "site", "src", "recipes", file), "utf8").replace(/\n+$/, "")
    assert.ok(shown.includes(recipe), `the page lacks the recipe ${file}`)
  }
})

test("the report is prefixlens's own HTML report, and the page names no coding agent", () => {
  assert.match(readFileSync(path.join(out, "report.html"), "utf8"), /<html/i)
  // The page is for teams that build harnesses and frameworks, whichever coding agent they use (site/README.md).
  const words = text(page.replace(/<(style|script)>[\s\S]*?<\/\1>/g, ""))
  assert.doesNotMatch(words, /Claude Code|Codex|Cursor|Copilot|opencode/)
  assert.doesNotMatch(prompt, /Claude Code|Codex|Cursor|Copilot|opencode/)
})
