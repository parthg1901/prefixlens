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

prefixlens 0.3 is unreleased and has so far run on one machine, Linux arm64 with Bun 1.4.0. It is meant to run on macOS too, and CI is set up to test it there, but it has not been run on macOS yet. What has been checked on real data, all on that machine: the recording proxy with real Claude Code traffic (Anthropic Messages) and real Codex traffic (OpenAI Responses with ChatGPT sign-in); the `claude-code` importer, on real Claude Code sessions and against the proxy's records of the same sessions (usage, tool hashes and message hashes identical on every call; every rebuilt request matched the digest Claude Code logged of the request it built; the importer then placed the one system block Claude Code adds without logging it, so that every other block and every breakpoint lines up with what the proxy recorded); and the `codex` importer, on real rollouts, whose per-response records match the proxy's calls one for one. opencode is not installed on that machine, so neither the proxy nor the `opencode` importer has been run against a real opencode; the `otel` importer has been tested only on synthetic fixtures. `wrap` and `lens.fetch` have run only against a simulated upstream, never against the real APIs. The prices in `pricing.json` have not been checked independently (see [Pricing](#pricing)).

## Install

prefixlens is not on a package registry yet; use it from a clone, or pack the clone and install the tarball.

Requirements: [Node.js](https://nodejs.org) 22 or later, or [Bun](https://bun.sh) 1.1 or later, on Linux or macOS. There are no runtime dependencies. Node 22 is the oldest Node line still supported upstream (Node 20 reached end of life in March 2026), and nothing in prefixlens needs a newer one except two features, which say so when they are missing instead of raising the minimum for everyone: reading an opencode SQLite database needs Node's built-in SQLite (Node 22.13 or later), and the proxy decodes zstd-compressed request bodies (Codex with ChatGPT sign-in sends them) only on Node 22.15 or later. Bun has both.

From a clone, with Bun (runs the TypeScript sources directly):

```sh
git clone <repository URL> prefixlens && cd prefixlens
bun install              # dev dependencies only: TypeScript, Bun's types, and the two SDKs the tests wrap
bun src/cli.ts --help    # the CLI, run from the checkout
```

Run `bun src/cli.ts` wherever this README says `prefixlens`. With Node, build first; `dist/` then holds the JavaScript and type declarations that ship:

```sh
bun install && bun run build    # or, without Bun: npm install --no-package-lock && npm run build
node dist/cli.js --help
```

To use the CLI, the library or `prefixlens/test` in another project, on Node or Bun, pack the checkout and install the tarball there:

```sh
cd prefixlens && npm pack                          # builds dist/ and writes prefixlens-<version>.tgz (nothing is published)
cd ../your-project && npm install --save-dev ../prefixlens/prefixlens-*.tgz    # or: bun add -d ../prefixlens/prefixlens-*.tgz
npx prefixlens --help
```

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

1 miss cost $0.02 at list prices; 1 from tool-list changes
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

The proxy forwards every request to the real API unchanged, credentials included, and streams each response back chunk by chunk as it arrives; it never buffers or rewrites a byte. When a model call ends, and only after the client has received every byte of the response, it appends one full-request record: the canonical request, the final usage, the request start time. Auth headers, cookies and API keys are never written, nor are identifying request fields or the bytes of images and documents (see [Security and privacy](#security-and-privacy)); the only headers kept are `session-id` (cache affinity on OpenAI's ChatGPT sign-in flow), `anthropic-beta`, `anthropic-version` and `openai-beta`. It prints one line per call, so you can watch the hit rate while you work:

```
#2 main gpt-6-luna: prompt 2,987, cache read 2,816 (94%), output 9
```

| option | meaning |
|---|---|
| `--provider anthropic\|openai` | Which API (required). Sets the default upstream. |
| `--port <n>` | Port (default 8787). |
| `--host <address>` | Listen address (default 127.0.0.1). |
| `-o, --out <file>` | Trace to append to (default `prefixlens.trace.jsonl`). |
| `--upstream <url>` | Forward somewhere else: a gateway, a regional endpoint. A path is prefixed to each request path. With `https://chatgpt.com` (Codex's ChatGPT sign-in backend) records are marked `"billing": "subscription"`. |
| `--allow-origin <origins>` | Let web pages from these origins (comma-separated, or `*`) call the proxy. By default a request with an `Origin` header is refused (403). |
| `--keep-identifiers` | Keep `metadata`, `user`, `safety_identifier` and `client_metadata` in the recorded params (left out by default). |
| `--keep-binary` | Keep base64 images, documents and audio in the trace instead of their SHA-256 and size. |
| `--quiet` | No line per call. |

Recorded: `POST …/messages` (Anthropic Messages), `…/chat/completions` and `…/responses` (OpenAI), streamed (SSE, with or without `[DONE]`, with `: keep-alive` comments) or not, and compressed request bodies (gzip, deflate, br, zstd). Everything else passes through unrecorded, as do error responses. WebSocket handshakes are answered `426 Upgrade Required` and never forwarded: the proxy relays HTTP only. A client that disconnects mid-stream is recorded only if the stream already reported usage (Anthropic does in its first event); the record is marked `"interrupted": true`, and the report shows the call as cut off, with its output and cost as lower bounds. A request whose `Host` is not a loopback name or the `--host` address, or that carries an `Origin` header (browsers send one, harness CLIs do not), is refused with 403 and not forwarded; this keeps a web page open in your browser from using the proxy. Chat Completions streams report usage only with `stream_options: {"include_usage": true}`; the proxy does not add it, since it never changes a request, so without it those calls are skipped with a note.

**Lanes.** One proxy often carries several conversations at once (subagents, title generation, side queries), and each call must be compared with the call it builds on. The proxy assigns lanes by shared prefix: a call joins the lane whose latest request it extends; else the lane it shares the most leading messages with, when it also shares the start of the request or that lane is idle with the same tools or system prompt (an edit, a mode switch); else an idle lane with the same tools and system prompt (a compaction); else it opens a new lane. A call that does not extend a lane joins it only when its cache key (the `session-id` header, else `prompt_cache_key`) matches, so a harness that names its conversations, as Codex does, gets a lane per conversation. A harness that knows better can send `x-prefixlens-lane` (and `x-prefixlens-session`); the proxy strips both before forwarding.

### The base URL to set, per harness

| harness | start the proxy with | then set |
|---|---|---|
| Claude Code | `--provider anthropic` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |
| Anthropic SDKs (TypeScript, Python) | `--provider anthropic` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |
| OpenAI SDKs (TypeScript, Python), and tools built on them | `--provider openai` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| Codex CLI, signed in with ChatGPT (its requests go to `https://chatgpt.com/backend-api/codex/responses`) | `--provider openai --upstream https://chatgpt.com` | `codex -c 'openai_base_url="http://127.0.0.1:8787/backend-api/codex"'`, or `openai_base_url` in `~/.codex/config.toml` |
| Codex CLI with an API key | `--provider openai` | `openai_base_url="http://127.0.0.1:8787/v1"` (as above) |
| A harness on the Responses API with ChatGPT sign-in (requests to `https://api.openai.com/v1/responses`) | `--provider openai` | its base URL option: `http://127.0.0.1:8787/v1` |
| opencode | the provider you use | `"provider": { "<id>": { "options": { "baseURL": "http://127.0.0.1:8787/v1" } } }` in `opencode.json` |

Checked here: the Codex ChatGPT sign-in row live (Codex CLI 0.167.0, five small `codex exec` runs through the proxy: every call recorded, the same calls and token counts as Codex's own rollout logs, no credential in the trace), and the other ChatGPT sign-in row live with another harness; the TypeScript SDK rows against a local stand-in for each API. Codex opens Responses over a WebSocket first; the proxy relays HTTP only and answers the handshake with 426, on which Codex switches to HTTP at once. A base URL ending in `/backend-api/codex` keeps the routes Codex uses only on its own backend (Codex's source decides this by that suffix). The Codex API-key row follows Codex's source (the same setting, with `https://api.openai.com/v1` as the default) and was not run. The Claude Code, Python SDK and opencode rows follow those tools' documented settings and were not run through the proxy here (opencode is not installed on the machine this was checked on).

## Quickstart: wrap your SDK client

```ts
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { wrap } from "prefixlens"

const anthropic = wrap(new Anthropic())                          // records to $PREFIXLENS_TRACE or ./prefixlens.trace.jsonl
const openai = wrap(new OpenAI(), { trace: "run.trace.jsonl" })
```

`wrap` works with the official TypeScript SDKs (`@anthropic-ai/sdk`, `openai`), streaming and helpers included (`messages.stream()`, `responses.stream()`, `.withResponse()`). It does not import either SDK: both send every request through the client's `fetch`, and `wrap` replaces it on the client you pass with one that records and passes every byte through as it arrives. It returns the same client; wrapping twice records once. Options: `trace` (a path, or `false` for none), `onRecord(record)`, `onSkip(reason)`, `session`, `lane`, `keepIdentifiers`, `keepBinary`.

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
import { test } from "node:test"          // or "bun:test"
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

1 miss cost $0.0036 at list prices; 1 from system-prompt changes. Also 2 intentional breaks declared by the harness cost $0.0067 at list prices (1 revert, 1 compaction).
```

`assertPrefixStable(prev, next, { allowBreak: "revert" })` allows exactly what a `revert` declaration excuses in the report. The rules are in [SPEC.md section 6.1](SPEC.md#61-declaring-an-intentional-break).

## What each adapter can and can't diagnose

Every adapter declares the fidelity it produces; `prefixlens adapters` prints this table.

| adapter | reads | fidelity | can diagnose | can't diagnose |
|---|---|---|---|---|
| `claude-code` | `~/.claude/projects/<project>/<session>.jsonl` and `<session>/subagents/*.jsonl` | **full-request** on recent Claude Code versions, whose logs record each request (its tools, system prompt, params, cache breakpoints, and messages by hash). prefixlens rebuilds every request and checks it against the SHA-256 digest Claude Code logged of the request as it built it; a rebuilt request that does not match is imported usage-only. That digest proves the tools, the logged system parts, the messages, the params and the breakpoints, not the bytes sent: Claude Code's transport then puts a first system block in front (a billing-attribution line that differs per session) that the log never contains, and sends the logged `betas` as the `anthropic-beta` header. The importer writes that block as an `unknown` block in its place, so every other block and breakpoint sits where it was sent, and `betas` as the header; the report says the system prompt is partly unknown. **usage-only** on older logs, which record responses only. | Full: every cause, with the first changed block and a diff: tool list and order changes (e.g. an MCP server dropping out), system prompt edits, edited, appended or removed messages, rewinds, compaction, param changes, expiry against the logged TTL, and provider-side misses with the prefix proven intact. Usage-only: hit rates, costs, model changes, likely expiry (TTL inferred from the 5-minute/1-hour write split), compaction from the transcript's compact boundaries. | Full: a change to the billing-attribution block (its content is unknown; a miss it caused reads as one with the prefix intact); changes the provider makes after the request leaves Claude Code (server-side context editing such as clearing old thinking, set by the `context_management` param), which show up as a miss with the prefix intact; and calls Claude Code bills but does not log one by one (compaction summaries, title and other side queries; the importer warns when Claude Code's own totals exceed the logged calls). Usage-only: no tool list, system prompt or history, so tool-list, tool-order, system-prompt and history changes cannot be told apart; such misses are reported as *cause unknown* rather than guessed. |
| `opencode` | `~/.local/share/opencode/opencode.db` (`opencode-<channel>.db` on other release channels; SQLite, the `session_v2/session_message` tables of current versions and the v1 `session/message/part` tables an upgraded install keeps) or a legacy `storage/` JSON directory | **usage-only** | Per-call hit rates and costs (one record per model step), model changes, likely expiry, and causes inferred from opencode's own records: compactions, agent switches (e.g. build → plan, which changes tools and system prompt), and old tool outputs pruned from history. opencode's `input` excludes cached tokens and its `output` excludes reasoning (its source). | Anything that needs the request: opencode stores the conversation and per-step usage, but not the tool list, system prompt or replayed history each call was sent with (newer versions keep the session's current instruction values, not a per-call record). Causes are labelled *inferred*, there are no block diffs, and a miss with no hint, model change or time gap is reported as *cause unknown*. A compaction row's usage covers all of that compaction's calls; title generation is recorded by opencode only as an event and is missed. Checked against opencode's table definitions and stored types in its source and on databases built from its own schema; not yet run on a database a running opencode wrote (opencode was not installed on the machine this was checked on). |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one file or a directory of them. Each file is one thread; a subagent's file joins its root session as a lane (`subagent:<thread id>`), and `--session <id>` takes a root session with its subagents | **usage-only** | Per-response hit rates and costs, model changes, likely expiry, compactions (with the compaction call itself marked), collaboration-mode switches, and tool-list changes, from the hash Codex logs for each tool definition (`world_state`; tools added, removed or redefined; inferred). Calls made with ChatGPT sign-in, which Codex logs with the plan's rate limits, are marked `"billing": "subscription"`. Usage is the API's own: Codex copies it from each `response.completed`, so `input_tokens` includes cached and cache-write tokens and output includes reasoning (Codex's source); on real rollouts the per-response records add up exactly to Codex's own running totals, and on sessions recorded through the proxy they match the proxy's calls one for one, by response id and token counts. | The request. Newer rollouts (0.167) log every input item, tool declarations included, and on the sessions recorded through the proxy they rebuilt each request's input block for block; but no version logs a request hash or the full parameters, and older versions send the tool list outside the logged items, so a rebuilt request cannot be shown to be the one sent: no block diffs, and instruction and history changes are *cause unknown* (tool-list changes are named from the logged tool hashes when newer versions log them). Timestamps are response ends, not request starts (2–7 s after the proxy's request starts here). Logs with `token_count` events only (no `token_usage_record` lines) do not report compaction calls. |
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

Prices live in [`pricing.json`](pricing.json), not in code. The bundled table has the pay-as-you-go API list prices of Anthropic, OpenAI and Gemini text models, standard tier, as published on the providers' own pricing pages and model pages on the table's `as_of` date. Its `sources` section lists every page used and when it was checked, and its `notes` say what is left out.

**Costs are list prices, not your bill.** A report's costs are what the calls would cost billed per token at those prices. Calls made on a subscription (a Claude plan, ChatGPT sign-in, Codex) are not billed per token at all. For them the numbers say what each miss would have cost on an API key, which is still the right scale for comparing misses. Negotiated discounts, Batch and Flex, OpenAI and Gemini priority tiers, data-residency uplifts and per-modality (audio) prices are not applied. A trace does not record how a call was billed, so every report says this in a note.

What an entry holds:

| field | meaning |
|---|---|
| `names` | Exact model ids: the provider's id, its documented aliases and dated snapshots (`claude-haiku-4-5`, `claude-haiku-4-5-20251001`). |
| `input`, `cache_read`, `output` | Per million tokens. Required. |
| `cache_write` | Write price for the default cache lifetime: Anthropic 5 minutes, OpenAI 30 minutes (GPT-5.6 and later; earlier OpenAI models and Gemini charge no writes). |
| `cache_write_1h` | Anthropic's 1-hour write price, applied to `cache_write_1h_tokens`. |
| `cache_write_12h` | OpenAI's 12-hour write price. Recorded only: a trace cannot yet say which OpenAI writes were 12-hour, so all of them are priced at `cache_write`. |
| `tiers` | Higher prices for the whole request when its prompt (uncached + read + written) is above `above_prompt_tokens`: Claude Haiku 5.5 above 100,000, OpenAI above 272,000, Gemini Pro above 200,000. |
| `from`, `until` | First and last UTC day a price applies, for promotions that end on a set date. Calls are priced by the day they were sent. |
| `when_params` | Request parameters that select the price. Anthropic fast mode is `{"speed": "fast"}`. |
| `cache_ttl_seconds`, `min_cacheable_tokens` | This model's cache lifetime and minimum cacheable prompt, overriding the provider's. They decide when a miss is called expiry and when a prompt is too short to cache. |

**How a model is matched.** The trace's model id and each name are compared after lowercasing and removing these parts:

- router and API prefixes (`openrouter/openai/`, `models/`);
- Bedrock region and vendor prefixes and version suffixes (`global.anthropic.`, `openai.`, `-v1:0`);
- the separators `@` (Google Cloud dates) and `.`, which are both read as `-`.

So `anthropic/claude-sonnet-4.5`, `claude-haiku-4-5@20251001` and `us.anthropic.claude-opus-4-1-20250805-v1:0` find their models. Matching then works like this:

- An entry that lists the id wins. Among those, one whose `when_params` match the request beats one without.
- Nothing else matches. A family name (`gpt-6`), an effort suffix (`gpt-6-luna-high`), a `-fast` suffix the provider does not document, or a hot-swapped alias (`gemini-flash-latest`) gets no price rather than a neighbour's.
- A model with no price, or none on the day of the call, is reported with its token counts and the note `No price for <model>: add it to the pricing table to get costs.` The rest of the report is unchanged.
- Your own table may also use glob patterns in a `match` field. They are tried only when no entry lists the id exactly.
- Two entries that list the same id for overlapping days and the same parameters are an error.

Cloud ids (Bedrock, Google Cloud) are priced at the first-party list price. Those platforms set their own prices.

**Keeping it current.** When the table is more than `stale_after_days` days old (60 in the bundled table) on the day you run a report, the report gives its age. To update prices:

1. Edit `pricing.json`, or copy it and pass your copy with `--pricing <file>` or `PREFIXLENS_PRICING=<file>`.
2. Change the figures from the provider's pricing page.
3. Set `as_of` and the provider's `sources.<provider>.checked` to the day you checked.

`--pricing` wins over `PREFIXLENS_PRICING`, which wins over the bundled table. Whichever is used, the models.dev prices below fill in only the models it does not list.

### A second source: models.dev

[models.dev](https://models.dev) is a community-maintained catalogue of models and their prices across more than 200 providers, including routers and clouds that resell the same models under their own ids. prefixlens can use it for models the hand-verified table does not list, and to notice when the table has gone stale. Its data is © 2025 models.dev, published under the [MIT licence](https://github.com/anomalyco/models.dev/blob/dev/LICENSE); thanks to its contributors. The file prefixlens writes carries the licence notice.

Nothing is fetched unless you ask:

```sh
prefixlens pricing update                     # fetch https://models.dev/api.json, convert it, save it
prefixlens pricing update --from api.json     # or convert a copy you saved (offline)
prefixlens pricing show claude-opus-5-5       # which price a model gets, from which source and date
prefixlens pricing check                      # where models.dev and the pricing table disagree (exit 1 if they do)
```

`update` fetches with a 30-second timeout and a 32 MB limit (the catalogue is about 6 MB), and fails with a clear message when offline. It prints what changed since the previous fetch (models added and removed, prices changed) and every disagreement with the pricing table. It saves only the converted prices, about 1 MB, to:

| platform | file |
|---|---|
| Linux and others | `$XDG_CACHE_HOME/prefixlens/models.dev.json`, else `~/.cache/prefixlens/models.dev.json` |
| macOS | `~/Library/Caches/prefixlens/models.dev.json` (or under `$XDG_CACHE_HOME` when set) |
| Windows | `%LOCALAPPDATA%\prefixlens\Cache\models.dev.json` |

Delete that file to stop using catalogue prices, or pass `--no-catalogue` to `report` or `pricing show`. The catalogue is not bundled with prefixlens: it changes daily and is mostly models no trace of yours will use. `pricing check` is meant for maintainers and a scheduled CI job: it fetches the catalogue (or reads `--from`), compares every entry of the pricing table in effect today with models.dev's entry for the same provider and id, and exits 1 when any shared figure differs.

**Which price a call gets.**

1. The pricing table (`--pricing`, else `PREFIXLENS_PRICING`, else the bundled one) wins for every model it lists, with every field: cache-write lifetimes, tiers, cache lifetime, minimum cacheable size, dated prices. A model it lists only on other days or with other parameters stays unpriced on the other days; the catalogue does not fill the gap.
2. For a model in both, the shared figures (input, cache read, the default-lifetime cache write, output, prompt-size tiers, and Anthropic fast mode) are compared. A difference becomes a report note naming both figures and both dates, and the table's price is used.
3. Only for a model the table does not list does the catalogue price the call, and the report says so in a note that names the models.dev entry, its last-updated date and the fetch date. Cache lifetime and minimum cacheable size then come from the table's provider defaults, since models.dev has neither.

**Provider and model identity.** A trace's `provider` names whose caching rules apply, not who billed the call (a call through OpenRouter to Claude is `anthropic`). It maps to one models.dev provider: `anthropic` to `anthropic`, `openai` to `openai`, `gemini` to `google`, and any other id to the models.dev provider of the same id (`deepseek`, `openrouter`). Within that one provider, the model id is matched exactly (lowercase, `.` and `@` read as `-`), then without leading `segment/` prefixes (`openrouter/anthropic/claude-x` → `anthropic/claude-x` → `claude-x`), then with the normalization the pricing table uses. When that last step finds several entries with different prices, such as a router's `vendor/model` ids or a cloud's regional ids (`us.anthropic.…` costs 10% more on Bedrock), the call gets no price and the note names the candidates. Another provider's price for a same-named model is never used, unless you opt in for models the table lacks:

```sh
prefixlens report run.trace.jsonl --catalogue-provider anthropic=openrouter,openai=openrouter
```

Aliases that a provider repoints at other models (`gemini-flash-latest`, any id ending in `latest`) get no catalogue price, as in the bundled table.

**What models.dev does not have, and what the report does about it.** It has no 1-hour (Anthropic) or 12-hour (OpenAI) cache-write price, no cache lifetime or minimum cacheable size, no dates on which a promotional price ends, and no record of where a figure came from. A catalogue price is used only when it lists every price the call needs; otherwise the call is reported unpriced, with a note saying which price was missing, rather than priced at a guess:

- no cache-read price: no call of that model is costed (a miss is costed against the cache-read price);
- no cache-write price: calls that wrote to the cache are not costed; calls that wrote nothing are;
- calls with 1-hour cache writes are not costed from the catalogue;
- a prompt-size tier that leaves out a price the base lists does not borrow the base's;
- a separate reasoning-token price: calls that report reasoning tokens are not costed;
- request parameters that select one of models.dev's per-mode prices (`speed: "fast"`) use that price, and a mode with no price leaves the call unpriced. OpenAI's `service_tier` modes are not applied, as in the bundled table.

## Trace format

A trace is JSON Lines, one record per model call: provider, model, params, the canonical request as ordered blocks (tools, system, each message) with a SHA-256 hash per block, the response usage, a timestamp, and a fidelity flag (`full-request` or `usage-only`). To keep long sessions small, block content is written once per trace and referenced by hash afterwards, and each call can reuse the unchanged leading blocks of the previous call instead of listing them again. Content can also be left out entirely to redact it.

[SPEC.md](SPEC.md) defines it precisely enough to emit from any language, with hash test vectors.

## Library

```ts
import { wrap, createLens, startProxy } from "prefixlens"           // recording
import { assertPrefixStable, explainPrefixDiff } from "prefixlens/test" // CI
import { canonicalizeRequest, comparePrefix, parseTrace, analyze, renderTerminal } from "prefixlens"
```

Beyond recording, the main export has the building blocks the CLI uses: canonicalize a provider request body into blocks, compare two requests, read and write traces (`parseTrace`, `serializeTrace`, `openTraceWriter`), analyze a trace and render reports. The package runs on Node 22 or later and on Bun, ships its type declarations, and has no runtime dependencies. `startProxy(options)` resolves once the proxy is listening, to `{ url, hostname, port, upstream, trace, stop() }`.

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

A trace contains, by design, the full content of every request it records: the full system prompt, every tool definition, the instruction files and memory the harness sends (`CLAUDE.md`, `AGENTS.md` and the like), your prompts, the contents of files the agent read, tool outputs, and earlier replies sent back as history. That usually includes working-directory paths and often your email address (harnesses put it in their system prompts and git context). **Treat a trace, and the HTML and JSON reports made from it, like source code plus personal data: keep it private and never commit it.**

What prefixlens leaves out by default: request fields that identify a person, account, device or installation and are not model input (`metadata`, which holds Claude Code's account id, device id and session id in `metadata.user_id`; `user`; `safety_identifier`; Codex's `client_metadata`), and the bytes of base64 images, documents and audio, which are written as their SHA-256 and size (block hashes still cover the bytes, so a changed image is still seen). `--keep-identifiers` / `keepIdentifiers` and `--keep-binary` / `keepBinary` keep them. Kept on purpose because the analysis needs them: `prompt_cache_key` and the `session-id` header, the keys providers route requests to a cache by; a harness may derive them from a session or user id.

Trace files that prefixlens creates (the proxy, `wrap`, `lens.fetch`, `lens.observe` with a trace path, `import -o`) and `report --html` files are readable and writable by you only (mode 0600), and directories it creates for them are 0700. A file that already exists keeps its permissions; the proxy and `import -o` warn when others can read it.

What is never written: every request header except `session-id`, `anthropic-beta`, `anthropic-version` and `openai-beta`, so no `authorization`, `x-api-key`, `cookie`, organization, project or account header; and the content of responses (only their usage, id and model are kept). Error responses and calls that are not model calls are not written at all. The proxy, `wrap`, `lens.fetch`, `lens.observe` and `buildRecord` all build records with the same function, so this holds for each of them.

The proxy forwards credentials to the provider unchanged, so it sees your API keys. It listens on `127.0.0.1` by default and has no authentication of its own: any process on the machine can send requests through it (with its own credentials) into your trace. It refuses requests whose `Host` is not a loopback name or the `--host` address (DNS rebinding) and requests with an `Origin` header (web pages), unless `--allow-origin` allows that origin. Binding it to another interface with `--host` sends your keys and prompts over plain HTTP and lets anyone who can reach the port send requests through it into your trace; so does an `http://` upstream on another machine. It warns at start-up in both cases.

prefixlens has no telemetry. Its only network traffic is the proxy forwarding to the configured upstream, `wrap`/`lens.fetch` passing requests to the client's own fetch, and, only when you run `prefixlens pricing update` or `prefixlens pricing check` without `--from`, one HTTP GET to `https://models.dev/api.json` with no body, cookies or credentials. `report` and `pricing show` never fetch.

Details, and how to report a vulnerability, are in [SECURITY.md](SECURITY.md).

## Development

```sh
bun install
bun test                                    # unit, adapter, CLI and privacy tests on Bun; fixtures are small and synthetic
bun run typecheck
bun run build                               # dist/: JavaScript and declarations, for Node and for the package
node --test "test-node/*.test.mjs"          # the built package on Node: CLI, library, assertions, proxy (npm run test:node builds first)
node scripts/check-package.mjs              # npm pack, install the tarball into temporary projects with npm and Bun, and use it there
cd examples/ci-prefix-test && bun test      # the CI example, which imports src/ through tsconfig paths
```

The sources run on Bun as they are. What differs between the runtimes is kept in `src/runtime/`: the proxy's HTTP server (`Bun.serve` or `node:http`, each releasing every byte of a response, the last included, before the record is built; `test/stream-order.test.ts` and `test-node/proxy.test.mjs` check this on each) and read-only SQLite (`bun:sqlite` or `node:sqlite`). Files, hashing and compression use `node:` modules, which both runtimes provide.

CI (`.github/workflows/ci.yml`) runs the Bun suite on Ubuntu and macOS with Bun 1.4.0, the Node suite and the package check on Node 22.0.0 and 26 on Ubuntu and macOS, and fails if a trace, session log or credential is committed.

Test fixtures are hand-written. Never commit real session logs or traces: they contain secrets and private code.

## Licence

MIT; see `LICENSE`.
