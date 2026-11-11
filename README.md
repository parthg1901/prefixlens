# prefixlens

**Cache regressions are silent and expensive. prefixlens catches them in CI before they reach your bill.**

prefixlens explains prompt-cache hits and misses for any LLM agent harness. It turns a run into a trace of model calls, works out for each call how much of the cache it should have read and how much it did, and when it missed, finds the first part of the request that changed: the tool list, the system prompt, a message rewritten after it was sent, an injected timestamp, a compaction, a model or parameter change. Then it says so in plain words:

```
turn 41: miss, tool list changed (+2 tools: 42 → 44), ~$0.38
```

This is version 0.1 (phase 1): it reads existing session logs. A recording proxy, SDK wrappers and CI assertions are planned (see [Roadmap](#roadmap)).

## Install

prefixlens runs on [Bun](https://bun.sh) (1.1 or later) on Linux and macOS.

```sh
git clone <this repo> prefixlens && cd prefixlens
bun install          # dev dependencies only; there are no runtime dependencies
bun link             # optional: puts `prefixlens` on your PATH
```

Without `bun link`, run `bun src/cli.ts` wherever this README says `prefixlens`.

## Quickstart: import an existing session

```sh
# Claude Code: one session file (its subagents/ directory is picked up too)
prefixlens import claude-code ~/.claude/projects/<project>/<session-id>.jsonl -o session.trace.jsonl

# opencode: list sessions, then import one
prefixlens import opencode ~/.local/share/opencode/opencode.db --list
prefixlens import opencode ~/.local/share/opencode/opencode.db --session <id> -o session.trace.jsonl

# Report
prefixlens report session.trace.jsonl            # terminal
prefixlens report session.trace.jsonl --json     # machine-readable
prefixlens report session.trace.jsonl --html     # writes session.trace.html, one self-contained file
```

`import` writes to stdout when `-o` is not given, so the two commands pipe: `prefixlens import opencode <db> | prefixlens report -`.

Output on a small synthetic session:

```
turn  time (UTC)  lane      model            prompt   read  write  uncached  out    hit     cost  status
   1  10:00:01    main      claude-opus-5-5   2,003      0  2,000         3   40     0%    $0.02  cold
   2  10:00:06    main      claude-opus-5-5   2,103  2,000    100         3   10  95.1%  $0.0014  hit
   3  10:00:10    agent-a1  claude-opus-5-5   1,502      0  1,500         2    5     0%  $0.0076  cold
   4  10:00:15    agent-a1  claude-opus-5-5   1,552  1,500     50         2    5  96.6%  $0.0007  hit
   5  10:00:21    main      claude-opus-5-5   2,303      0  2,300         3   12     0%    $0.02  miss: tool list changed (+1 tool: 2 → 3)

Misses
  turn 5: miss, tool list changed (+1 tool: 2 → 3), ~$0.02
    lost 2,100 of 2,100 cached tokens · vs turn 2 · lane main · confirmed
    + web_fetch

1 miss cost $0.02; 1 from tool-list changes
```

Long sessions hide the hit rows in the terminal (`--all` shows them); the HTML report always has every row, a chart of prompt tokens per call, and the diff for each miss.

### Report options

| option | meaning |
|---|---|
| `--json` | Print the full analysis as JSON (summary, every call, causes, diffs). |
| `--html [file]` | Write a self-contained HTML report (default `<trace>.html`). No external requests. |
| `--pricing <file>` | Use another pricing table (also `PREFIXLENS_PRICING`). |
| `--tolerance <tokens>` | Lost tokens still counted as a hit (default 128). |
| `--all` | Show every row and every miss in the terminal. |
| `--no-color` | Plain output (also when `NO_COLOR` is set or output is not a terminal). |

## What each adapter can and can't diagnose

Every adapter declares the fidelity it produces; `prefixlens adapters` prints this table.

| adapter | reads | fidelity | can diagnose | can't diagnose |
|---|---|---|---|---|
| `claude-code` | `~/.claude/projects/<project>/<session>.jsonl` and `<session>/subagents/*.jsonl` | **full-request** on recent Claude Code versions (the log has `api-request` records); **usage-only** on older logs | Full: every cause, with the first changed block and a diff: tool list and order changes (e.g. an MCP server dropping out), system prompt edits, edited, appended or removed messages, rewinds, compaction, param changes, expiry against the logged TTL, and provider-side misses with the prefix proven intact. Usage-only: hit rates, costs, model changes, likely expiry (TTL inferred from the 5-minute/1-hour write split), compaction from the transcript's compact boundaries. | Calls Claude Code bills but does not log one by one (compaction summaries, small side queries); the importer warns when Claude Code's own totals exceed the logged calls. On old logs, the cause of a miss is never proven. |
| `opencode` | `~/.local/share/opencode/opencode.db` (SQLite, both the v1 `session/message/part` tables and the newer `session_v2/session_message` tables) or a legacy `storage/` JSON directory | **usage-only** | Per-call hit rates and costs (one record per model step), model changes, likely expiry, and causes inferred from opencode's own records: compactions, agent switches (e.g. build → plan, which changes tools and system prompt), and old tool outputs pruned from history. | Anything that needs the request: opencode stores the conversation and per-step usage but not the system prompt, tool list or replayed history it actually sent, so causes are labelled *inferred* and there are no block diffs. |

Usage-only traces always say so: hit rates and costs are exact, but a root-cause diff needs full requests.

## Why caches miss

Prompt caching is a prefix match. The provider caches the request up to a point, and the next request reuses that cache only if it starts with exactly the same tokens. Anthropic renders a request as tools, then system prompt, then messages, so a change anywhere invalidates everything after it. Most misses are not the provider's fault; they come from the harness rewriting its own prefix:

- **The tool list changed.** A mode switch trims 47 tools to 42, or an MCP server reconnects. Tools come first, so this invalidates everything.
- **The tool order changed.** The same tools, sorted by whichever MCP server connected first.
- **History was rewritten after the fact.** Old tool outputs truncated or expanded on replay, reasoning blocks dropped, a reminder appended to an old message.
- **Steps were reshaped on replay.** Consecutive tool calls merged into one message, or one split into two.
- **Instructions were refreshed mid-session.** The system prompt rebuilt with a new timestamp, a re-read instructions file, or a changed environment block.
- **Compaction.** History replaced by a summary. Expected, but each one costs a full re-write.
- **Model or parameter changes.** Caches are per model; on Anthropic, changing thinking settings or `tool_choice` invalidates cached messages.
- **Provider-side or expiry misses.** The prefix is intact, but more time passed than the TTL (5 minutes by default, 1 hour if requested), or the provider evicted or routed elsewhere.

prefixlens separates these: with full requests it proves which block changed, or that none did.

## How it decides

For each call it looks at the previous call in the same lane (subagents get their own lane):

- **expected cached tokens**: what the previous call left in the cache (Anthropic: what it read plus what it wrote; OpenAI and Gemini: its whole prompt once it is long enough to cache);
- **lost tokens**: expected minus what this call read; more than 128 lost is a partial miss, almost nothing read is a miss;
- **miss cost**: lost tokens × (the price paid for them − the cache-read price);
- **cause**: the first changed block in prefix order, or, with the prefix intact, expiry versus a provider-side miss.

The exact rules are in [SPEC.md](SPEC.md#8-how-prefixlens-analyzes-a-trace-informative).

## Pricing

Prices live in [`pricing.json`](pricing.json), not in code. Each model entry has per-million-token rates for input, output, cache reads, 5-minute cache writes and 1-hour cache writes, matched by glob on the model id (with `provider/` prefixes stripped and `.` read as `-`), plus optional tiers by prompt size. Edit it, or pass your own with `--pricing` or `PREFIXLENS_PRICING`. Models missing from the table are reported with token counts and no cost. The Anthropic prices are list prices as of the table's `as_of` date; the OpenAI and Gemini rows are there as a starting point and should be checked.

## Trace format

A trace is JSON Lines, one record per model call: provider, model, params, the canonical request as ordered blocks (tools, system, each message) with a SHA-256 hash per block, the response usage, a timestamp, and a fidelity flag (`full-request` or `usage-only`). To keep long sessions small, block content is written once per trace and referenced by hash afterwards, and each call can reuse the unchanged leading blocks of the previous call instead of listing them again. Content can also be left out entirely to redact it.

[SPEC.md](SPEC.md) defines it precisely enough to emit from any language, with hash test vectors.

## Library

The modules are importable from TypeScript (`import { canonicalizeRequest, comparePrefix, analyze } from "prefixlens"`): canonicalize a provider request body into blocks, compare two requests, analyze a trace, render reports. The API will settle with the phase 2 `prefixlens` and `prefixlens/test` exports.

## Roadmap

Planned for v1, not in this release:

- `prefixlens record --provider anthropic|openai --port 8787`: a local recording proxy; point a harness at it with `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`. Auth headers are never written.
- `prefixlens.wrap(client)` for the Anthropic and OpenAI TypeScript SDKs, and `lens.observe({ request, response })` for custom clients.
- `prefixlens/test`: `assertPrefixStable(prev, next)` and `explainPrefixDiff(prev, next)` for CI.
- A Codex adapter and an OpenTelemetry GenAI importer.

## Development

```sh
bun test            # unit, adapter and CLI tests; fixtures are small and synthetic
bun run typecheck
```

Test fixtures are hand-written. Never commit real session logs or traces: they contain secrets and private code.
