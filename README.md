# prefixlens

**Cache regressions are silent and expensive. prefixlens catches them in CI before they reach your bill.**

prefixlens explains prompt-cache hits and misses for any LLM agent harness. It turns a run into a trace of model calls, works out for each call how much of the cache it should have read and how much it did, and when it missed, finds the first part of the request that changed: the tool list, the system prompt, a message rewritten after it was sent, an injected timestamp, a compaction, a model or parameter change. Then it says so in plain words:

```
turn 41: miss, tool list changed (+2 tools: 42 → 44), ~$0.38
```

A harness that breaks its prefix on purpose (a compaction, a revert, a model change the user asked for) can say so in the trace. That call is then reported as an intentional break, with its cost shown and totalled apart from the misses that point at bugs.

There are four ways in:

- **import** a harness's existing session logs (Claude Code, opencode, Codex, OpenTelemetry GenAI spans);
- **record** live traffic with a local proxy that every harness can point its base URL at;
- **wrap** an Anthropic or OpenAI SDK client in your own harness (or `observe` calls from a custom client);
- **test** prefix stability in CI with `prefixlens/test`, before a regression reaches your bill.

## Status

prefixlens 0.3 is unreleased and has so far run on one machine, Linux arm64 with Bun 1.4.0. It is meant to run on macOS too, and CI is set up to test it there, but it has not been run on macOS yet. What has been checked on real data: the `claude-code` importer, on Claude Code sessions from that machine (every rebuilt request matched the digest Claude Code logged, and call counts, token totals and costs matched an independent recount from the raw logs); the `codex` importer, on one real rollout file; and the recording proxy, live against OpenAI's Responses API with ChatGPT sign-in. The `opencode` and `otel` importers have been tested only on synthetic fixtures. The Anthropic paths of the proxy and of `wrap`, and `wrap` with the OpenAI SDK, have run only against a simulated upstream, never against the real APIs. The prices in `pricing.json` have not been checked independently (see [Pricing](#pricing)).

## Install

prefixlens is not on a package registry yet; use it from a clone.

Requirements: [Bun](https://bun.sh) 1.1 or later (developed and tested with 1.4.0), on Linux or macOS. It does not run on Node.js yet: the package's entry points are TypeScript sources and the proxy uses `Bun.serve`. There are no runtime dependencies.

```sh
git clone <repository URL> prefixlens && cd prefixlens
bun install              # dev dependencies only: TypeScript, Bun's types, and the two SDKs the tests wrap
bun src/cli.ts --help    # the CLI, run from the checkout
```

Run `bun src/cli.ts` wherever this README says `prefixlens`, or put `prefixlens` on your PATH with `bun link` (run in the checkout; it links to the checkout, so a `git pull` updates it).

To use the library or `prefixlens/test` in another project, link the checkout into it:

```sh
cd prefixlens && bun link              # once, in the checkout
cd ../your-project && bun link prefixlens
```

and add `"prefixlens": "link:prefixlens"` to that project's `devDependencies` so that `bun install` keeps the link. The project has to run on Bun (its tests with `bun test`), since prefixlens is imported as TypeScript.

## Quickstart: import an existing session

```sh
# Claude Code: one session file (its subagents/ directory is picked up too)
prefixlens import claude-code ~/.claude/projects/<project>/<session-id>.jsonl -o session.trace.jsonl

# opencode: list sessions, then import one
prefixlens import opencode ~/.local/share/opencode/opencode.db --list
prefixlens import opencode ~/.local/share/opencode/opencode.db --session <id> -o session.trace.jsonl

# Codex: one rollout file, or a directory of them
prefixlens import codex ~/.codex/sessions/2026/01/01/rollout-<timestamp>-<id>.jsonl -o session.trace.jsonl

# OpenTelemetry GenAI spans (an OTLP/JSON export)
prefixlens import otel spans.json -o session.trace.jsonl

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

## Quickstart: record with the proxy

```sh
prefixlens record --provider anthropic -o run.trace.jsonl     # listens on 127.0.0.1:8787
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude                # in another terminal: use the harness as usual
# Ctrl-C the proxy, then
prefixlens report run.trace.jsonl
```

The proxy forwards every request to the real API unchanged, credentials included, and streams each response back chunk by chunk as it arrives; it never buffers or rewrites a byte. When a model call ends it appends one full-request record: the canonical request, the final usage, the request start time. Auth headers, cookies and API keys are never written; the only headers kept are `session-id` (cache affinity on OpenAI's ChatGPT sign-in flow), `anthropic-beta`, `anthropic-version` and `openai-beta`. It prints one line per call, so you can watch the hit rate while you work:

```
#2 main gpt-6-luna: prompt 2,987, cache read 2,816 (94%), output 9
```

| option | meaning |
|---|---|
| `--provider anthropic\|openai` | Which API (required). Sets the default upstream. |
| `--port <n>` | Port (default 8787). |
| `--host <address>` | Listen address (default 127.0.0.1). |
| `-o, --out <file>` | Trace to append to (default `prefixlens.trace.jsonl`). |
| `--upstream <url>` | Forward somewhere else: a gateway, a regional endpoint. A path is prefixed to each request path. |
| `--quiet` | No line per call. |

Recorded: `POST …/messages` (Anthropic Messages), `…/chat/completions` and `…/responses` (OpenAI), streamed (SSE, with or without `[DONE]`, with `: keep-alive` comments) or not, and compressed request bodies (gzip, deflate, br, zstd). Everything else passes through unrecorded, as do error responses. A client that disconnects mid-stream is recorded only if the stream already reported usage (Anthropic does in its first event; the record is marked `"complete": false`). Chat Completions streams report usage only with `stream_options: {"include_usage": true}`; the proxy does not add it, since it never changes a request, so without it those calls are skipped with a note.

**Lanes.** One proxy often carries several conversations at once (subagents, title generation, side queries), and each call must be compared with the call it builds on. The proxy assigns lanes by shared prefix: a call joins the lane whose latest request it extends; else the lane it shares the most leading messages with, when it also shares the start of the request or that lane is idle with the same tools or system prompt (an edit, a mode switch); else an idle lane with the same tools and system prompt (a compaction); else it opens a new lane. A harness that knows better can send `x-prefixlens-lane` (and `x-prefixlens-session`); the proxy strips both before forwarding.

### The base URL to set, per harness

| harness | start the proxy with | then set |
|---|---|---|
| Claude Code | `--provider anthropic` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |
| Anthropic SDKs (TypeScript, Python) | `--provider anthropic` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |
| OpenAI SDKs (TypeScript, Python), and tools built on them | `--provider openai` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| A harness on the Responses API with ChatGPT sign-in (requests to `https://api.openai.com/v1/responses`) | `--provider openai` | its base URL option: `http://127.0.0.1:8787/v1` |
| opencode | the provider you use | `"provider": { "<id>": { "options": { "baseURL": "http://127.0.0.1:8787/v1" } } }` in `opencode.json` |

Checked here: the ChatGPT sign-in row live, through the proxy; the TypeScript SDK rows against a local stand-in for each API. The Claude Code, Python SDK and opencode rows follow those tools' documented settings and were not run through the proxy here.

## Quickstart: wrap your SDK client

```ts
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { wrap } from "prefixlens"

const anthropic = wrap(new Anthropic())                          // records to $PREFIXLENS_TRACE or ./prefixlens.trace.jsonl
const openai = wrap(new OpenAI(), { trace: "run.trace.jsonl" })
```

`wrap` works with the official TypeScript SDKs (`@anthropic-ai/sdk`, `openai`), streaming and helpers included (`messages.stream()`, `responses.stream()`, `.withResponse()`). It does not import either SDK: both send every request through the client's `fetch`, and `wrap` replaces it on the client you pass with one that records and passes every byte through as it arrives. It returns the same client; wrapping twice records once. Options: `trace` (a path, or `false` for none), `onRecord(record)`, `onSkip(reason)`, `session`, `lane`.

For other clients:

```ts
import { createLens } from "prefixlens"

const lens = createLens({ trace: "run.trace.jsonl" })

// A client that takes a fetch function (most do):
const client = new MyClient({ fetch: lens.fetch() })

// Or report each call yourself, after the response ends:
lens.observe({
  request: body,                     // the request body as sent: Responses, Chat Completions or Anthropic Messages
  response: completedEvent,          // final JSON, the parsed stream events, the SSE text, or the final event alone
  startedAt: requestStart,           // cache lifetimes run from the request start
  headers: { "session-id": cacheKey },
})
```

## Quickstart: test prefix stability in CI

```ts
import { test } from "bun:test"
import { assertPrefixStable } from "prefixlens/test"

test("each step extends the previous request", () => {
  const first = harness.buildRequest(session)
  session.append(toolCall, toolResult)
  assertPrefixStable(first, harness.buildRequest(session))
})
```

`assertPrefixStable(prev, next, options?)` throws a `PrefixBreakError` unless `next` keeps every block of `prev` unchanged, in place, with the same model and cache-relevant parameters. `explainPrefixDiff(prev, next, options?)` returns the same explanation without throwing (`stable`, `ok`, `appended`, `unchanged`, `change`, `block`, `fix`, `message`). Both are pure functions with no network. `prev` and `next` can be request bodies as sent (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses; Gemini with `provider: "gemini"`), canonical requests, trace records, or block lists.

A failure names the first changed block and what changed, shows a small diff, and says what to do:

```
PrefixBreakError: prefix not stable: tool order changed (3 of 3 tools moved; same tools, different order)

  first changed block: 1 of 5 (tool "write_file", now tool "read_file"); nothing before it matches, so the whole request is re-read

    - [0]: write_file
    - [1]: run_shell
    - [2]: read_file
    + [0]: read_file
    + [1]: write_file
    + [2]: run_shell

  fix: build the tool list in a deterministic order (sort it once, e.g. by name) instead of connection or map order.
  if this change is intentional, pass { allowBreak: { reason: "..." } }
```

Options:

| option | meaning |
|---|---|
| `allowBreak: "revert"` | An intentional break, with the same meaning as a `prefix_break` hint in a trace ([below](#declaring-intentional-breaks)). The reason sets how far it may reach: `"revert"` and `"refusal"` must keep the tools and system prompt; `"compaction"`, `"model_switch"`, `"settings_change"` and any other reason may change anything. A `"compaction"` reason also names the change as one. |
| `allowBreak: { after, reason }` | The prefix may change only after `after`: `"start"` (anywhere, model included), `"tools"`, `"system"` (tools and instructions must survive, e.g. a compaction that keeps them), `{ message: n }`, or a block count. |
| `ignoreParams: ["truncation"]` | Parameters to leave out, for one you have shown your provider does not cache on. The built-in rules per provider are in [SPEC.md section 8.1](SPEC.md#81-which-request-parameters-are-part-of-the-cached-prefix). |
| `hints` | Trace hints (`[{ kind: "compaction" }]`) to name the change. A `prefix_break`, `compaction` or `model_switch` hint also allows the break, exactly as the report would; so do the hints of `next` when it is a trace record. |
| `provider` | Request format, when the body shape is ambiguous. Also picks the parameter rules. |

[`examples/ci-prefix-test`](examples/ci-prefix-test) is a small project whose `bun test` suite catches the four common bugs: tools sorted differently each turn, a timestamp in the system prompt, an already-sent message rewritten, and the tool list changing on a mode switch. It also shows two legitimate changes passing: `tool_choice: "none"` on the last step, and a declared revert.

## Declaring intentional breaks

Some prefix breaks are deliberate: the harness compacts history and rebuilds its instructions, the user reverts to an earlier point, a refused exchange is left out of history, the user picks another model or reasoning effort. Declare each one on the first call after it, as a hint in the trace record:

```json
"hints": [{ "kind": "prefix_break", "reason": "revert", "detail": "reverted to message 12" }]
```

| reason | for | may change |
|---|---|---|
| `compaction` | history summarized or replaced, instructions possibly rebuilt | anything |
| `revert` | conversation rewound to an earlier point | messages only (tools and system prompt must stay) |
| `refusal` | a refused exchange left out of history | messages only |
| `model_switch` | another model | anything |
| `settings_change` | a parameter changed on purpose, e.g. reasoning effort | anything |

`after` overrides how far a break may reach (`"start"`, `"tools"`, `"system"`, `{"message": n}` or a block count). The older `compaction` and `model_switch` hints still declare a break; `agent_switch` and `tool_output_pruned` do not, since a mode switch that changes the tool list is exactly the kind of change prefixlens should catch.

A declaration is not a way to make misses disappear:

- it excuses the miss of the call it is on and nothing else; a second miss right after it is a miss;
- it excuses only a change where its reason allows: a declared revert that also changed the tool list is reported as a miss, with the reason;
- it never excuses a miss with the prefix intact (expiry, provider-side);
- the report shows each intentional break with what changed and what it cost, and totals that cost separately (`summary.intentional`, `summary.cost.intentional` in `--json`); `summary.misses` and the miss cost count only the rest.

```
   4  10:01:20    gpt-4.1   2,000      0      -     2,000   40     0%  $0.0043  intentional break (compaction): system prompt changed (part 1 of 1 edited)
   7  10:02:20    gpt-4.1   2,500      0      -     2,500   40     0%  $0.0053  intentional break (revert): conversation rewound at message #3: …
   8  10:02:40    gpt-4.1   2,900      0      -     2,900   40     0%  $0.0061  miss: system prompt changed (part 1 of 1 edited)

1 miss cost $0.0036; 1 from system-prompt changes. Also 2 intentional breaks declared by the harness cost $0.0067 (1 revert, 1 compaction).
```

`assertPrefixStable(prev, next, { allowBreak: "revert" })` allows exactly what a `revert` declaration excuses in the report. The rules are in [SPEC.md section 6.1](SPEC.md#61-declaring-an-intentional-break).

## What each adapter can and can't diagnose

Every adapter declares the fidelity it produces; `prefixlens adapters` prints this table.

| adapter | reads | fidelity | can diagnose | can't diagnose |
|---|---|---|---|---|
| `claude-code` | `~/.claude/projects/<project>/<session>.jsonl` and `<session>/subagents/*.jsonl` | **full-request** on recent Claude Code versions, whose logs record each request (its tools, system prompt, params, cache breakpoints, and messages by hash). prefixlens rebuilds every request and checks it against the SHA-256 digest Claude Code logged for the body it sent; a rebuilt request that does not match is imported usage-only. **usage-only** on older logs, which record responses only. | Full: every cause, with the first changed block and a diff: tool list and order changes (e.g. an MCP server dropping out), system prompt edits, edited, appended or removed messages, rewinds, compaction, param changes, expiry against the logged TTL, and provider-side misses with the prefix proven intact. Usage-only: hit rates, costs, model changes, likely expiry (TTL inferred from the 5-minute/1-hour write split), compaction from the transcript's compact boundaries. | Full: changes the provider makes after the request leaves Claude Code (server-side context editing such as clearing old thinking, set by the `context_management` param), which show up as a miss with the prefix intact; and calls Claude Code bills but does not log one by one (compaction summaries, title and other side queries; the importer warns when Claude Code's own totals exceed the logged calls). Usage-only: no tool list, system prompt or history, so tool-list, tool-order, system-prompt and history changes cannot be told apart; such misses are reported as *cause unknown* rather than guessed. |
| `opencode` | `~/.local/share/opencode/opencode.db` (SQLite, both the v1 `session/message/part` tables and the newer `session_v2/session_message` tables) or a legacy `storage/` JSON directory | **usage-only** | Per-call hit rates and costs (one record per model step), model changes, likely expiry, and causes inferred from opencode's own records: compactions, agent switches (e.g. build → plan, which changes tools and system prompt), and old tool outputs pruned from history. | Anything that needs the request: opencode stores the conversation and per-step usage, but not the tool list, system prompt or replayed history each call was sent with (newer versions keep the session's current instruction values, not a per-call record). Causes are labelled *inferred*, there are no block diffs, and a miss with no hint, model change or time gap is reported as *cause unknown*. |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one file or a directory of them | **usage-only** | Per-response hit rates and costs (from Codex's per-response usage records), model changes, likely expiry, compactions and collaboration-mode switches (inferred). | The request: Codex logs history items and the base instructions, but not the tool list or the exact request of each call, so no block diffs. Timestamps are response ends, not request starts. Written from the record shapes of Codex rollouts on the development machine and tested on synthetic fixtures; not checked against Codex's source. |
| `otel` | OpenTelemetry GenAI spans: an OTLP/JSON export, JSONL of exports, or a JSON array of spans | **usage-only** | Per-call hit rates and costs from `gen_ai.usage.*` (cache reads and writes included), model changes, likely expiry; `gen_ai.conversation.id` becomes the session. | The request: the content attributes are opt-in and not the exact request, so no block diffs. Follows the semantic conventions (`input_tokens` includes cached tokens); a span whose cache counts exceed its input is read as reporting input without cache, with a warning. |

Usage-only traces always say so: hit rates and costs are exact, but a root-cause diff needs full requests. Each miss in a report is labelled *confirmed* (proven from two full requests), *inferred* (from timing, a model change or the harness's own log) or *unknown*.

## Why caches miss

Prompt caching is a prefix match. The provider caches the request up to a point, and the next request reuses that cache only if it starts with exactly the same tokens. Anthropic renders a request as tools, then system prompt, then messages, so a change anywhere invalidates everything after it. Most misses are not the provider's fault; they come from the harness rewriting its own prefix:

- **The tool list changed.** A mode switch trims 47 tools to 42, or an MCP server reconnects. Tools come first, so this invalidates everything.
- **The tool order changed.** The same tools, sorted by whichever MCP server connected first.
- **History was rewritten after the fact.** Old tool outputs truncated or expanded on replay, reasoning blocks dropped, a reminder appended to an old message.
- **Steps were reshaped on replay.** Consecutive tool calls merged into one message, or one split into two.
- **Instructions were refreshed mid-session.** The system prompt rebuilt with a new timestamp, a re-read instructions file, or a changed environment block.
- **Compaction.** History replaced by a summary. Expected, but each one costs a full re-write.
- **Model or parameter changes.** Caches are per model. Which parameters count depends on the provider: on Anthropic, changing thinking, effort or `tool_choice` invalidates cached messages (documented); on OpenAI, reasoning effort, verbosity, the output format and `parallel_tool_calls` count (documented), and `tool_choice` does not (measured on the Responses API).
- **Provider-side or expiry misses.** The prefix is intact, but more time passed than the TTL (5 minutes by default, 1 hour if requested), or the provider evicted or routed elsewhere.

prefixlens separates these: with full requests it proves which block changed, or that none did.

## How it decides

For each call it looks at the previous call in the same lane (subagents get their own lane):

- **expected cached tokens**: what the previous call left in the cache (Anthropic: what it read plus what it wrote; OpenAI and Gemini: its whole prompt, in 128-token steps, once it is long enough to cache);
- **lost tokens**: expected minus what this call read; more than 128 lost is a partial miss, almost nothing read is a miss;
- **miss cost**: lost tokens × (the price paid for them − the cache-read price);
- **cause**: the first changed block in prefix order, or, with the prefix intact, expiry versus a provider-side miss.

The exact rules are in [SPEC.md](SPEC.md#8-how-prefixlens-analyzes-a-trace-informative).

### Which request parameters count

A parameter change explains a miss only if the provider caches on it. prefixlens keeps a table per provider ([SPEC.md section 8.1](SPEC.md#81-which-request-parameters-are-part-of-the-cached-prefix), `PARAM_RULES` in code), and says for each entry how it knows:

| | verified (measured live) | documented (provider's caching docs) | assumed |
|---|---|---|---|
| Anthropic | | `tool_choice` (messages only), `thinking`, `output_config.effort`, `speed` | sampling and output limits don't count; `context_management`, `mcp_servers` do |
| OpenAI | `tool_choice` does not count (Responses API) | `reasoning`, `text`, `parallel_tool_calls`, `context_management`, `prompt_cache_key` count | `tool_choice` on Chat Completions; the Chat names `reasoning_effort`, `verbosity`, `response_format`; sampling, limits, `store`, `include` don't count |
| Gemini | | | everything but sampling and limits counts |

Any parameter not in the table is assumed to count, so a change is never silently ignored.

## Pricing

Prices live in [`pricing.json`](pricing.json), not in code. Each model entry has per-million-token rates for input, output, cache reads, 5-minute cache writes and 1-hour cache writes, matched by glob on the model id (with `provider/` prefixes stripped and `.` read as `-`), plus optional tiers by prompt size. Edit it, or pass your own with `--pricing` or `PREFIXLENS_PRICING`. Models missing from the table are reported with token counts and no cost. The Anthropic prices are list prices as of the table's `as_of` date; the OpenAI and Gemini rows are there as a starting point and should be checked.

## Trace format

A trace is JSON Lines, one record per model call: provider, model, params, the canonical request as ordered blocks (tools, system, each message) with a SHA-256 hash per block, the response usage, a timestamp, and a fidelity flag (`full-request` or `usage-only`). To keep long sessions small, block content is written once per trace and referenced by hash afterwards, and each call can reuse the unchanged leading blocks of the previous call instead of listing them again. Content can also be left out entirely to redact it.

[SPEC.md](SPEC.md) defines it precisely enough to emit from any language, with hash test vectors.

## Library

```ts
import { wrap, createLens, startProxy } from "prefixlens"           // recording
import { assertPrefixStable, explainPrefixDiff } from "prefixlens/test" // CI
import { canonicalizeRequest, comparePrefix, parseTrace, analyze, renderTerminal } from "prefixlens"
```

Beyond recording, the main export has the building blocks the CLI uses: canonicalize a provider request body into blocks, compare two requests, read and write traces (`parseTrace`, `serializeTrace`, `openTraceWriter`), analyze a trace and render reports. The package runs on Bun and has no runtime dependencies.

To write traces from your own harness that are identical to what the proxy records, call the proxy's own record builder:

```ts
import { buildRecord, readResponse, serializeTrace } from "prefixlens"

const record = buildRecord({
  api: "openai-responses",                          // or "anthropic-messages", "openai-chat"
  body,                                             // the request body as sent
  response: readResponse("openai-responses", raw),  // raw: the JSON body, the SSE text, or the parsed events
  startedAt,                                        // Date, epoch ms or ISO string: when the request was sent
  headers,                                          // optional; only session-id, anthropic-beta, anthropic-version, openai-beta are kept
  session, lane: "main", recorder: "proxy",         // optional; lane defaults to "main", recorder to "library"
})
if (typeof record === "string") console.warn(`not recorded: ${record}`)  // the response reported no usage
else trace.push(record)  // add hints (e.g. a prefix_break) before writing; serializeTrace(trace) writes the lines
```

Its signature is stable from 0.3: inputs may gain optional fields, never lose or change one.

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## Security and privacy

A trace holds the full content of every request it records: your prompts, the system prompt, tool definitions, the code and files the agent read, tool outputs, and earlier replies sent back as history, plus request parameters as sent (including identifiers some harnesses put in the body, such as `metadata.user_id` or `user`). **Treat traces, and the HTML and JSON reports made from them, as sensitive, and never commit them.** Trace files get your default file permissions.

What is never written: every request header except `session-id`, `anthropic-beta`, `anthropic-version` and `openai-beta`, so no `authorization`, `x-api-key`, `cookie`, organization, project or account header; and the content of responses (only their usage, id and model are kept). Error responses and calls that are not model calls are not written at all. The proxy, `wrap`, `lens.fetch`, `lens.observe` and `buildRecord` all build records with the same function, so this holds for each of them.

The proxy forwards credentials to the provider unchanged, so it sees your API keys. It listens on `127.0.0.1` by default and has no authentication of its own. Binding it to another interface with `--host` sends your keys and prompts over plain HTTP and lets anyone who can reach the port send requests through it into your trace.

prefixlens has no telemetry: its only network traffic is the proxy forwarding to the configured upstream, and `wrap`/`lens.fetch` passing requests to the client's own fetch.

Details, and how to report a vulnerability, are in [SECURITY.md](SECURITY.md).

## Development

```sh
bun install
bun test                                    # unit, adapter, CLI and privacy tests; fixtures are small and synthetic
bun run typecheck
cd examples/ci-prefix-test && bun test      # the CI example, which imports src/ through tsconfig paths
```

CI (`.github/workflows/ci.yml`) runs these on Ubuntu and macOS with Bun 1.4.0, and fails if a trace, session log or credential is committed.

Test fixtures are hand-written. Never commit real session logs or traces: they contain secrets and private code.

## Licence

MIT; see `LICENSE`.
