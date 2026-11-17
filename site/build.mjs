// Builds the landing page into site/public (or the directory given as the first argument): one index.html with its
// styles and script inlined, the instructions for a coding agent as agent.md, and a real HTML report of the sample
// session. Everything the page shows of prefixlens's output is produced here by the built command line
// (dist/cli.js) from test/fixtures/agent-session.jsonl.
//
// site/public is committed, and it is what the host serves: no build runs at deploy time. Run this after a change
// to site/src or to what prefixlens prints, and commit the result; test-node/site.test.mjs fails while the
// committed page is not what this script gives.
//
//   npm run build && node site/build.mjs [out-dir]
//
// Runs under Node 22 or later, or Bun, with no dependencies.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const site = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(site, "..")
const src = path.join(site, "src")
const args = process.argv.slice(2)
// `--og <dir>` writes only og.html there: the page to screenshot at 1200 by 630 for src/og.png (site/README.md).
const ogDir = args.includes("--og") ? path.resolve(args[args.indexOf("--og") + 1] ?? ".") : null
const out = path.resolve(args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--og") ?? path.join(site, "public"))
const cli = path.join(root, "dist", "cli.js")
const fixture = path.join(root, "test", "fixtures", "agent-session.jsonl")
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const ORIGIN = "https://prefixlens.parthg.dev"
// Served from the site itself, so that the page waits on no other host (licences: src/fonts/*.OFL.txt).
const FONTS = ["schibsted-grotesk.woff2", "spline-sans-mono.woff2"]

if (!existsSync(cli)) {
  console.error("site: dist/cli.js is missing. Build the package first: npm run build")
  process.exit(1)
}

const read = (...parts) => readFileSync(path.join(src, ...parts), "utf8").replace(/\n+$/, "")
const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// The sample session, under the name the page calls it by, so that the output names the same file.
const work = mkdtempSync(path.join(tmpdir(), "prefixlens-site-"))
const TRACE = "run.trace.jsonl"
copyFileSync(fixture, path.join(work, TRACE))
const prefixlens = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: work, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
const must = (result, status, what) => {
  if (result.status !== status) {
    console.error(`site: ${what} exited ${result.status}, expected ${status}\n${result.stderr}`)
    process.exit(1)
  }
  return result.stdout
}

const checkText = must(prefixlens(["check", TRACE]), 1, "prefixlens check on the sample session").replace(/\n+$/, "")
const report = JSON.parse(must(prefixlens(["report", TRACE, "--json"]), 0, "prefixlens report --json"))
must(prefixlens(["report", TRACE, "--html", "report.html"]), 0, "prefixlens report --html")
const blocksPerCall = readFileSync(fixture, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line).request?.blocks?.length ?? 0)

// ---------------------------------------------------------------- the check's output, as the terminal shows it

function terminal(text) {
  // Each line is a block indented as the tool indents it, so that a long line wraps under its own start.
  return text
    .split("\n")
    .map((line) => {
      const indent = line.length - line.trimStart().length
      const body = line.trimStart()
      const safe = escape(body)
      const shown = /^FAIL\b/.test(body)
        ? `<span class="t-fail">${safe}</span>`
        : /^ok\b/.test(body)
          ? `<span class="t-ok">${safe}</span>`
          : /^turn \d+:/.test(body)
            ? safe.replace(/^(turn \d+:)/, '<span class="t-turn">$1</span>')
            : /^[+-] /.test(body)
              ? `<span class="t-add">${safe}</span>`
              : /^fix:/.test(body)
                ? safe.replace(/^(fix:)/, '<span class="t-fix">$1</span>')
                : /^prefixlens check:/.test(body) || /^\d+ calls?:/.test(body)
                  ? `<span class="t-dim">${safe}</span>`
                  : safe
      return `<span class="t-line" style="--in:${indent}">${shown === "" ? "&nbsp;" : shown}</span>`
    })
    .join("")
}

// ---------------------------------------------------------------- the session as a ledger: one bar per call

const money = (amount) => `$${amount.toFixed(2)}`
const count = (tokens) => Number(tokens).toLocaleString("en-US")
const longest = Math.max(...report.turns.map((turn) => turn.prompt_tokens))

function ledgerRow(turn, index) {
  const read = turn.usage.cache_read_tokens ?? 0
  const share = turn.prompt_tokens > 0 ? (read / turn.prompt_tokens) * 100 : 0
  const missed = turn.status === "miss" || turn.status === "partial"
  const hit = `${(turn.hit_rate * 100).toFixed(turn.hit_rate > 0 && turn.hit_rate < 1 ? 1 : 0)}%`
  const rest = missed ? "seg--lost" : "seg--write"
  const note =
    turn.status === "cold"
      ? "A cold start: the prefix is written to the cache."
      : missed
        ? `<b>${escape(turn.cause?.summary ?? "the prefix changed")}</b>: ${count(turn.lost_tokens)} cached tokens paid again, about ${money(turn.miss_cost)}.`
        : ""
  // Where in the request the prefix stopped matching, by its position among the request's blocks.
  const blocks = blocksPerCall[index] ?? 0
  const at = missed && turn.cause?.block_index !== undefined && blocks > 0 ? Math.min(94, Math.max(6, ((turn.cause.block_index + 0.5) / blocks) * 100)) : null
  const label = `Turn ${turn.turn}: ${turn.status}, ${hit} of the prompt read from the cache, ${money(turn.cost.total)}.${missed ? ` ${turn.cause?.summary ?? ""}.` : ""}`
  return [
    `      <li class="row row--${escape(turn.status)}" style="--i:${index}; --w:${((turn.prompt_tokens / longest) * 100).toFixed(1)}; --read-share:${share.toFixed(1)}" aria-label="${escape(label)}">`,
    `        <span class="row__turn" aria-hidden="true">${String(turn.turn).padStart(2, "0")}</span>`,
    `        <span class="row__bar" aria-hidden="true">${read > 0 ? '<i class="seg--read"></i>' : ""}<i class="${rest}"></i>${at === null ? "" : `<span class="lens" style="--at:${at.toFixed(1)}"></span>`}</span>`,
    `        <span class="row__hit" aria-hidden="true">${hit}</span>`,
    `        <span class="row__cost" aria-hidden="true">${money(turn.cost.total)}</span>`,
    note === "" ? "" : `        <span class="row__note" aria-hidden="true">${note}</span>`,
    "      </li>",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

// ---------------------------------------------------------------- code, lightly coloured

const KEYWORDS = new Set(["import", "from", "const", "let", "await", "async", "for", "of", "new", "type", "export", "test"])

/** TypeScript with its comments, strings and a few keywords wrapped; the text itself is unchanged. */
function typescript(code) {
  let html = ""
  let plain = ""
  const flush = () => {
    html += escape(plain).replace(/\b([a-z]+)\b/g, (word) => (KEYWORDS.has(word) ? `<span class="h-k">${word}</span>` : word))
    plain = ""
  }
  for (let i = 0; i < code.length; ) {
    const char = code[i]
    if (char === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i) === -1 ? code.length : code.indexOf("\n", i)
      flush()
      html += `<span class="h-c">${escape(code.slice(i, end))}</span>`
      i = end
    } else if (char === '"' || char === "'" || char === "`") {
      let end = i + 1
      while (end < code.length && code[end] !== char) end += code[end] === "\\" ? 2 : 1
      flush()
      html += `<span class="h-s">${escape(code.slice(i, end + 1))}</span>`
      i = end + 1
    } else {
      plain += char
      i += 1
    }
  }
  flush()
  return html
}

/** A shell script with its comments wrapped. */
function shell(code) {
  return code
    .split("\n")
    .map((line) => {
      const at = line.search(/(^|\s)#/)
      if (at === -1) return escape(line)
      const start = line[at] === "#" ? at : at + 1
      return `${escape(line.slice(0, start))}<span class="h-c">${escape(line.slice(start))}</span>`
    })
    .join("\n")
}

/** The instructions as they are shown: headings, fenced code and bold marked, and not one character changed, since the copy button copies this text. */
function instructions(markdown) {
  let fenced = false
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) {
        fenced = !fenced
        return `<span class="p-code">${escape(line)}</span>`
      }
      if (fenced) return `<span class="p-code">${escape(line)}</span>`
      if (line.startsWith("# ")) return `<span class="p-h p-h1">${escape(line)}</span>`
      if (line.startsWith("#")) return `<span class="p-h">${escape(line)}</span>`
      return escape(line).replace(/\*\*[^*]+\*\*/g, (bold) => `<span class="p-b">${bold}</span>`)
    })
    .join("\n")
}

// ---------------------------------------------------------------- the page

const prompt = read("agent.md").replaceAll("{{version}}", version)
const values = {
  version: escape(version),
  styles: read("styles.css"),
  script: read("app.js"),
  ledger: report.turns.map(ledgerRow).join("\n"),
  check_output: terminal(checkText),
  prompt: instructions(prompt),
  recipe_own: typescript(read("recipes", "own.ts")),
  recipe_ai_sdk: typescript(read("recipes", "ai-sdk.ts")),
  recipe_mastra: typescript(read("recipes", "mastra.ts")),
  mastra_output: escape(read("recipes", "mastra-output.txt")),
  recipe_proxy: shell(read("recipes", "proxy.sh")),
}
const page = read("index.html").replace(/\{\{([a-z_]+)\}\}/g, (whole, key) => {
  if (!(key in values)) throw new Error(`site: index.html asks for {{${key}}}, which the build does not give`)
  return values[key]
})

if (ogDir !== null) {
  // The picture is taken from a file, where "/name.woff2" leads nowhere: the fonts are read from src/fonts.
  const styles = values.styles.replaceAll('url("/', `url("file://${path.join(src, "fonts")}/`)
  const ledger = /<figure class="ledger[\s\S]*?<\/figure>/.exec(page)[0]
  mkdirSync(ogDir, { recursive: true })
  writeFileSync(
    path.join(ogDir, "og.html"),
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><style>${styles}</style></head>\n<body class="og">\n<div><span class="mark"><span class="mark__prefix">prefix</span><span class="mark__lens">lens</span></span><h1>Find the request that <em>broke</em> your prompt cache.</h1><p class="og__sub">Prompt-cache regression tests for agent harnesses and frameworks.</p></div>\n${ledger}\n</body></html>\n`,
  )
  rmSync(work, { recursive: true, force: true })
  console.log(`site: wrote og.html to ${path.relative(process.cwd(), ogDir) || "."}`)
  process.exit(0)
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0b0b0c"/><rect x="5" y="9" width="22" height="5" fill="#ffffff"/><rect x="5" y="18" width="9" height="5" fill="#ffffff"/><rect x="16" y="18" width="11" height="5" fill="#ff4d00"/></svg>\n`

// A report states when it was generated. When nothing else in it changed, the one already there is kept, so that
// building again does not touch a committed file.
const stamp = / · generated [^<]*/
const previousReport = existsSync(path.join(out, "report.html")) ? readFileSync(path.join(out, "report.html"), "utf8") : null
const newReport = readFileSync(path.join(work, "report.html"), "utf8")
const reportText = previousReport !== null && previousReport.replace(stamp, "") === newReport.replace(stamp, "") ? previousReport : newReport

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, "index.html"), `${page}\n`)
writeFileSync(path.join(out, "agent.md"), `${prompt}\n`)
writeFileSync(path.join(out, "favicon.svg"), favicon)
writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`)
writeFileSync(path.join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${ORIGIN}/</loc></url>\n</urlset>\n`)
// What the tool is and where its documents are, for a program that reads the site instead of a person.
writeFileSync(path.join(out, "llms.txt"), `${read("llms.txt").replaceAll("{{version}}", version)}\n`)
// With this file the host answers an unknown address with 404, not with the page.
copyFileSync(path.join(src, "404.html"), path.join(out, "404.html"))
copyFileSync(path.join(src, "og.png"), path.join(out, "og.png"))
for (const font of FONTS) copyFileSync(path.join(src, "fonts", font), path.join(out, font))
// Cloudflare Pages reads response headers from this file. The instructions are served as Markdown that any page may fetch.
writeFileSync(
  path.join(out, "_headers"),
  ["/*", "  Referrer-Policy: strict-origin-when-cross-origin", "  X-Content-Type-Options: nosniff", "", "/agent.md", "  Content-Type: text/markdown; charset=utf-8", "  Access-Control-Allow-Origin: *", "", "/llms.txt", "  Content-Type: text/plain; charset=utf-8", "  Access-Control-Allow-Origin: *", ...FONTS.flatMap((font) => ["", `/${font}`, "  Cache-Control: public, max-age=31536000, immutable"]), ""].join("\n"),
)
// prefixlens writes a report readable by its owner only, since a real one holds prompts. This one is published.
writeFileSync(path.join(out, "report.html"), reportText, { mode: 0o644 })
rmSync(work, { recursive: true, force: true })

console.log(`site: wrote index.html, agent.md, llms.txt, report.html, 404.html, og.png, favicon.svg, two fonts, robots.txt, sitemap.xml and _headers to ${path.relative(process.cwd(), out) || "."} (prefixlens ${version})`)
