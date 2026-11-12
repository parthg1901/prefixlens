// The package version, read from package.json beside src/ (or dist/) at load time, so the same code
// runs from a checkout and from the built package on Bun and on Node without importing JSON.

import { readFileSync } from "node:fs"

export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version
