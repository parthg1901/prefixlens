// Log adapters: convert a harness's own session files into trace records.

import type { Fidelity, TraceRecord } from "../trace.ts"
import { importClaudeCode } from "./claude-code.ts"
import { importCodex } from "./codex.ts"
import { importOpencode, listOpencodeSessions } from "./opencode.ts"
import { importOtel } from "./otel.ts"

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
  {
    name: "codex",
    fidelity: "usage-only",
    description: "Codex CLI rollout files (rollout-<timestamp>-<uuid>.jsonl), or a directory of them (each file one session).",
    defaultPath: "~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl",
    diagnoses:
      "Usage only: hit rates and costs per model response, with causes inferred from model changes, timing, compactions and collaboration-mode switches. Codex logs the history items and base instructions but not the exact request (tool list, per-call instructions), so no block diffs; other misses are 'cause unknown'. Timestamps are response ends, not request starts. Written from the record shapes in local Codex rollouts and tested on synthetic fixtures only.",
    import: importCodex,
  },
  {
    name: "otel",
    fidelity: "usage-only",
    description: "OpenTelemetry GenAI spans: an OTLP/JSON export, JSONL of exports, or a JSON array of spans.",
    defaultPath: "<otlp-export>.json",
    diagnoses:
      "Usage only: hit rates and costs per chat span (gen_ai.usage.*), with causes inferred from model changes and timing. Content attributes are opt-in and not the exact request, so no block diffs; other misses are 'cause unknown'. Assumes input_tokens includes cached tokens, as the GenAI semantic conventions specify.",
    import: importOtel,
  },
]

export function findAdapter(name: string): Adapter | undefined {
  return ADAPTERS.find((adapter) => adapter.name === name)
}
