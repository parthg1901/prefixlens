// Builds dist/ for Node and Bun: compiles src/ with tsc (tsconfig.build.json), then makes two
// changes tsc does not: the CLI gets a Node shebang and is made executable, and the declaration
// files import each other by their .js names (tsc rewrites .ts imports in JavaScript only).
// Runs under Node or Bun: `npm run build` or `bun run build`.

import { spawnSync } from "node:child_process"
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
rmSync(dist, { recursive: true, force: true })

const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc")
const compiled = spawnSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.build.json")], { stdio: ["ignore", 2, 2] })
if (compiled.status !== 0) process.exit(compiled.status ?? 1)

const files = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath, entry.name))

const relativeTs = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+)\.ts(["'])/g
for (const file of files.filter((name) => name.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8")
  const rewritten = text.replace(relativeTs, "$1$2.js$3")
  if (rewritten !== text) writeFileSync(file, rewritten)
}

const leftover = files.filter((name) => name.endsWith(".js") && new RegExp(relativeTs.source).test(readFileSync(name, "utf8")))
if (leftover.length > 0) {
  console.error(`build: relative .ts imports left in ${leftover.map((name) => path.relative(root, name)).join(", ")}`)
  process.exit(1)
}

const cli = path.join(dist, "cli.js")
const source = readFileSync(cli, "utf8")
if (!source.startsWith("#!/usr/bin/env bun\n")) {
  console.error("build: src/cli.ts no longer starts with the Bun shebang this script replaces")
  process.exit(1)
}
writeFileSync(cli, `#!/usr/bin/env node\n${source.slice(source.indexOf("\n") + 1)}`)
chmodSync(cli, 0o755)
console.error(`built ${files.filter((name) => name.endsWith(".js")).length} modules into dist/`)
