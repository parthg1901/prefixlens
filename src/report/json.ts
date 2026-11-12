// Machine-readable report: the analysis plus where it came from.

import type { Analysis } from "../analyze.ts"

export interface JsonOptions {
  trace?: string
  pricing?: { source: string; as_of?: string; catalogue?: { source: string; fetched_at: string } }
}

export function renderJson(analysis: Analysis, options: JsonOptions = {}): string {
  return JSON.stringify({ report: "prefixlens", ...(options.trace ? { trace: options.trace } : {}), ...(options.pricing ? { pricing: options.pricing } : {}), ...analysis }, null, 2) + "\n"
}
