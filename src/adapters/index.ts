// Log adapters: convert a harness's own session files into trace records.

import type { Fidelity, TraceRecord } from "../trace.ts"
import { importClaudeCode } from "./claude-code.ts"
import { importOpencode, listOpencodeSessions } from "./opencode.ts"

export interface ImportOptions {
  /** Session to import, for stores that hold many sessions. */
  session?: string
  /** Include subagent sessions as separate lanes. Default true. */
  subagents?: boolean
}

export interface ImportResult {
  records: TraceRecord[]
  warnings: string[]
}

export interface SessionSummary {
  id: string
  title?: string
  updated: string
  parent?: string
}

export interface Adapter {
  name: string
  /** Best fidelity this adapter can produce. */
  fidelity: Fidelity
  description: string
  /** Where the harness keeps its logs by default. */
  defaultPath: string
  /** What the adapter can and cannot diagnose. */
  diagnoses: string
  import(input: string, options: ImportOptions): Promise<ImportResult>
  list?(input: string): Promise<SessionSummary[]>
}

export const ADAPTERS: Adapter[] = [
  {
    name: "claude-code",
    fidelity: "full-request",
    description: "Claude Code session logs (<session>.jsonl, plus its subagents/ directory).",
    defaultPath: "~/.claude/projects/<project>/<session-id>.jsonl",
    diagnoses:
      "Full requests when the log has api-request records (recent Claude Code versions), each checked against the request digest Claude Code logged: every cause, with diffs; not server-side context edits, nor calls Claude Code does not log one by one. Older logs give usage only: hit rates, costs, expiry and compaction hints; tool, system-prompt and history changes cannot be seen, so those misses are 'cause unknown'.",
    import: importClaudeCode,
  },
  {
    name: "opencode",
    fidelity: "usage-only",
    description: "opencode local storage: opencode.db (SQLite) or the legacy storage/ JSON directory.",
    defaultPath: "~/.local/share/opencode/opencode.db",
    diagnoses:
      "Usage only: hit rates and costs per model call, with causes inferred from model changes, timing, compactions, agent switches and pruned tool outputs. opencode does not log the tool list, system prompt or history each call was sent with, so no block diffs; other misses are 'cause unknown'.",
    import: importOpencode,
    list: listOpencodeSessions,
  },
]

export function findAdapter(name: string): Adapter | undefined {
  return ADAPTERS.find((adapter) => adapter.name === name)
}
