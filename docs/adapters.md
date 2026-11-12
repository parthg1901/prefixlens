# Importers

The usual way to get a trace is to record one: through the [proxy](proxy.md), a [wrapped client](library.md), or your own code writing the [trace format](../SPEC.md). Those traces hold full requests.

If you already have logs, `prefixlens import` converts them to a trace. There is an importer for OpenTelemetry GenAI spans, which any harness can emit, and one each for the session logs of three coding agents.

```sh
# OpenTelemetry GenAI spans (an OTLP/JSON export)
prefixlens import otel spans.json -o session.trace.jsonl

# Claude Code: one session file (its subagents/ directory is picked up too)
prefixlens import claude-code ~/.claude/projects/<project>/<session-id>.jsonl -o session.trace.jsonl

# Codex: one rollout file, or a directory of them
prefixlens import codex ~/.codex/sessions/2026/01/01/rollout-<timestamp>-<id>.jsonl -o session.trace.jsonl

# opencode: list sessions, then import one
prefixlens import opencode ~/.local/share/opencode/opencode.db --list
prefixlens import opencode ~/.local/share/opencode/opencode.db --session <id> -o session.trace.jsonl

prefixlens report session.trace.jsonl
```

`import` writes to stdout when `-o` is not given, so the two commands pipe: `prefixlens import otel spans.json | prefixlens report -`.

| option | meaning |
|---|---|
| `-o, --out <file>` | Write the trace here (default: stdout). |
| `--session <id>` | The session to import, for stores holding many. |
| `--list` | List the sessions in the store instead of importing. |
| `--no-subagents` | Leave out subagent sessions. |

## What an importer can diagnose

A log rarely holds the request as it was sent. Every importer declares the fidelity it produces:

| importer | fidelity |
|---|---|
| [`otel`](#otel) | usage-only |
| [`claude-code`](#claude-code) | full-request on recent versions, usage-only on older logs |
| [`codex`](#codex) | usage-only |
| [`opencode`](#opencode) | usage-only |

A usage-only trace gives exact hit rates and costs. It has no tool list, system prompt or history to compare, so:

- causes are *inferred* from timing, model changes and what the harness logged;
- there are no block diffs;
- a miss nothing explains is reported as *cause unknown* rather than guessed.

To see which block changed, record full requests instead. `prefixlens adapters` prints a short form of this page.

## `otel`

**Reads:** OpenTelemetry GenAI spans: an OTLP/JSON export, JSONL of exports, or a JSON array of spans.

**Fidelity:** usage-only.

**Can diagnose:**

- per-call hit rates and costs from `gen_ai.usage.*`, cache reads and writes included;
- model changes and likely expiry.

`gen_ai.conversation.id` becomes the session.

**Cannot diagnose:**

- the request. The content attributes are opt-in and not the exact request, so there are no block diffs.

The importer follows the semantic conventions, in which `input_tokens` includes cached tokens. A span whose cache counts exceed its input is read as reporting input without cache, with a warning.

## `claude-code`

**Reads:** `~/.claude/projects/<project>/<session>.jsonl` and `<session>/subagents/*.jsonl`.

**Fidelity:**

- **full-request** on recent Claude Code versions, whose logs record each request: its tools, system prompt, params, cache breakpoints, and messages by hash;
- **usage-only** on older logs, which record responses only.

For a full-request log, the importer rebuilds every request and checks it against the SHA-256 digest Claude Code logged of the request as it built it. A rebuilt request that does not match is imported usage-only.

That digest proves the tools, the logged system parts, the messages, the params and the breakpoints. It does not prove the bytes sent:

- Claude Code's transport puts a first system block in front, a billing-attribution line that differs per session, which the log never contains. The importer writes that block as an `unknown` block in its place, so every other block and breakpoint sits where it was sent. The report says the system prompt is partly unknown.
- The logged `betas` are sent as the `anthropic-beta` header, and the importer writes them as that header.

A directory is imported with each model call once. A resumed or forked conversation starts its file with a copy of the earlier file's lines; the copy in the file that starts earliest is kept (same call id and timestamp), and a warning says how many copies were left out. One such file imported alone keeps the calls it copied.

**Can diagnose, with full requests:** every cause, with the first changed block and a diff:

- tool list and tool order changes, such as an MCP server dropping out;
- system prompt edits;
- edited, appended or removed messages, rewinds and compaction;
- parameter changes;
- expiry, against the logged cache lifetime;
- misses with every recorded block intact. These are reported as provider-side but *inferred*, since the billing-attribution block cannot be compared.

**Can diagnose, usage-only:** hit rates, costs, model changes, likely expiry (the cache lifetime is inferred from the 5-minute/1-hour write split), and compaction from the transcript's compact boundaries.

**Cannot diagnose, with full requests:**

- a change to the billing-attribution block. Its content is unknown, so a miss it caused reads as one with the prefix intact;
- changes the provider makes after the request leaves Claude Code, such as server-side context editing that clears old thinking (set by the `context_management` param). They show up as a miss with the prefix intact;
- calls Claude Code bills but does not log one by one: compaction summaries, title and other side queries. The importer warns when Claude Code's own totals exceed the logged calls.

**Cannot diagnose, usage-only:** tool-list, tool-order, system-prompt and history changes cannot be told apart. Such misses are *cause unknown*.

## `codex`

**Reads:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one file or a directory of them.

Each file is one thread. A subagent's file joins its root session as a lane (`subagent:<thread id>`), and `--session <id>` takes a root session with its subagents.

**Fidelity:** usage-only.

**Can diagnose:**

- per-response hit rates and costs;
- model changes and likely expiry;
- compactions, with the compaction call itself marked;
- collaboration-mode switches;
- tool-list changes (tools added, removed or redefined), inferred from the hash Codex logs for each tool definition (`world_state`).

Calls made with ChatGPT sign-in, which Codex logs with the plan's rate limits, are marked `"billing": "subscription"`.

Usage is the API's own. Codex copies it from each `response.completed`, so `input_tokens` includes cached and cache-write tokens, and output includes reasoning.

**Cannot diagnose:**

- the request. No version logs a request hash or the full parameters, and older versions send the tool list outside the logged items. A rebuilt request cannot be shown to be the one sent, so there are no block diffs, and instruction and history changes are *cause unknown*.

Two more limits:

- Timestamps are response ends, not request starts, so gaps between calls are measured end to end.
- Logs with `token_count` events only (no `token_usage_record` lines) do not report compaction calls.

## `opencode`

**Reads:** `~/.local/share/opencode/opencode.db`, or `opencode-<channel>.db` on other channels (`opencode db path` prints it). Three layouts are read:

- the `session/message/part` tables that released versions write;
- the `session_v2/session_message` tables of opencode's development code;
- a legacy `storage/` JSON directory.

Reading the SQLite database needs Bun, or Node 22.13 or later (Node's built-in SQLite).

**Fidelity:** usage-only.

**Can diagnose:**

- per-call hit rates and costs, one record per model call;
- model changes and likely expiry;
- causes inferred from opencode's records: compactions, agent switches (e.g. build → plan), pruned tool outputs.

In these records `input` excludes cached tokens and `output` excludes reasoning. `ts` is the creation time of the message, shortly before the request is sent.

**Cannot diagnose:**

- anything that needs the request. opencode stores the conversation and per-call usage. It does not store the tool list, system prompt, parameters or replayed history, nor a request hash, and neither `opencode export` nor any log level records requests. Use the proxy.
- title-generation calls. They are not stored, so they are missing from the trace, with a warning.
