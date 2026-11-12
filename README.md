# prefixlens

Explains prompt-cache hits and misses for any agent, harness or framework that calls a model API.

Cache regressions are silent and expensive: one reordered tool list or a timestamp in the system prompt, and every later request pays full price. prefixlens shows which request broke the cache, why, and what it cost. It also catches the break in CI, before it reaches your bill.

It works on the request itself. Anything that sends OpenAI Responses, OpenAI Chat Completions or Anthropic Messages requests can use it with no adapter: your own harness, an SDK, a framework such as the Vercel AI SDK or Mastra, or a gateway.

A session of an agent whose tool list grew before its fourth call:

```
turn  time (UTC)  model            prompt   read  write  uncached  out    hit   cost  status
   1  10:00:02    claude-opus-5-5   48.2k      0  48.2k        12  140     0%  $0.24  cold
   2  10:00:09    claude-opus-5-5   48.6k  48.2k    420        12   95  99.1%  $0.01  hit
   3  10:00:17    claude-opus-5-5   49.0k  48.6k    380        12  110  99.2%  $0.01  hit
   4  10:00:26    claude-opus-5-5   49.9k      0  49.9k        12  160     0%  $0.25  miss: tool list changed (+1 tool: 3 → 4)
   5  10:00:34    claude-opus-5-5   50.3k  49.9k    350        12   60  99.3%  $0.01  hit

Misses
  turn 4: miss, tool list changed (+1 tool: 3 → 4), ~$0.24
    lost 49,000 of 49,000 cached tokens · vs turn 3 · confirmed
    + web_search

1 miss cost $0.24 at list prices; 1 from tool-list changes
```

## Install

```sh
npm install --save-dev prefixlens    # or: bun add -d prefixlens
```

Requires Node.js 22 or later, or Bun 1.1 or later. There are no runtime dependencies.

## Quickstart

### 1. Test prefix stability in CI

Build the request for two consecutive steps the way your harness does, and assert that the second keeps the first one's prefix. Nothing is sent to a provider.

```ts
import { test } from "node:test"                  // or "bun:test"
import { assertPrefixStable } from "prefixlens/test"

// Stand-in for your harness: the request body it sends for a given history.
const buildRequest = (messages) => ({
  model: "claude-opus-5-5",
  max_tokens: 1024,
  system: "You are a coding agent.",
  tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }],
  messages,
})

test("a new step extends the previous request", () => {
  const history = [{ role: "user", content: "Fix the failing test." }]
  const first = buildRequest(history)
  const second = buildRequest([...history, { role: "assistant", content: "Reading it now." }, { role: "user", content: "Go on." }])
  assertPrefixStable(first, second)
})
```

When the builder puts the current time in the system prompt, the test fails with the first changed block, a diff and a fix:

```
PrefixBreakError: prefix not stable: system prompt changed: a timestamp value was updated (2026-01-01T10:00:00Z → 2026-01-01T10:00:01Z)

  first changed block: 2 of 3 (system part 1); block 1 still matches, everything from block 2 on is re-read

      type: text
    - text: You are a coding agent. Now: 2026-01-01T10:00:00Z
    + text: You are a coding agent. Now: 2026-01-01T10:00:01Z

  fix: keep clocks and ids out of the system prompt: send them in a new message, or round them (to the day, say).
  if this change is intentional, pass { allowBreak: { reason: "..." } }
```

More in [assertions](https://github.com/parthg1901/prefixlens/blob/main/docs/assertions.md).

### 2. Record through the proxy

Point any client's base URL at a local proxy. It forwards every request unchanged and records each model call.

```sh
npx prefixlens record --provider anthropic -o run.trace.jsonl   # or --provider openai; listens on 127.0.0.1:8787
```

In another terminal, set the base URL and run your agent as usual:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787   # with --provider openai: OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

Stop the proxy with Ctrl-C, then read the report:

```sh
npx prefixlens report run.trace.jsonl          # add --html for a self-contained page, --json for the data
```

Credentials are forwarded and never written. More in [proxy](https://github.com/parthg1901/prefixlens/blob/main/docs/proxy.md).

### 3. Wrap your client

Record from inside your own process, with no proxy:

```ts
import Anthropic from "@anthropic-ai/sdk"
import { wrap } from "prefixlens"

const client = wrap(new Anthropic(), { trace: "run.trace.jsonl" })   // also wrap(new OpenAI())
```

For a client or framework that is not one of those SDKs:

```ts
import { createLens } from "prefixlens"

const lens = createLens({ trace: "run.trace.jsonl" })
const recordingFetch = lens.fetch()             // pass it to any client or framework that accepts a fetch function
lens.observe({ request: body, response })       // or report each call yourself: the body as sent, the response as received
```

`buildRecord` builds the same record from a request and a response you already have. From another language, write the [trace format](SPEC.md) or use the proxy. More in [library](https://github.com/parthg1901/prefixlens/blob/main/docs/library.md).

## Works with

Any client of the Anthropic Messages, OpenAI Chat Completions or OpenAI Responses request formats, on a provider with implicit or explicit prompt caching. There is no per-harness adapter.

| | |
|---|---|
| Assertions | Request bodies in those three formats, and Gemini `generateContent` bodies with `provider: "gemini"`. |
| Proxy, `wrap`, `lens.fetch`, `lens.observe`, `buildRecord` | Calls in those three formats, streamed or not. A gateway's or another provider's compatible endpoint is recorded in the format it uses. |
| Caching | Implicit caches (OpenAI, Gemini) and explicit breakpoints (Anthropic `cache_control`, OpenAI `prompt_cache_breakpoint`). |
| Other languages | The proxy, or a trace written to [SPEC.md](SPEC.md). |

## What it tells you

For each call: prompt tokens read from the cache, written and uncached, the hit rate and the cost. For each miss: the first changed block, a diff, the tokens lost, the cost, and one of these causes.

| cause | what happened |
|---|---|
| Tool-list changes | A tool added, removed, redefined or reordered. |
| System-prompt changes | The system prompt edited, or a timestamp, id or relative date in it rendered again. |
| History rewrites | A sent message edited, inserted, removed or reordered; a tool output or reasoning block rewritten on replay; a sliding window; a rewind. |
| Reshaped steps | Messages merged or split on replay. |
| Compaction | History replaced by a summary. |
| Model or parameter changes | Another model, or a change to a parameter the provider caches on. |
| Cache expiry | The prefix is intact, but the call came after the cache lifetime. |
| Provider-side misses | The prefix is intact and in time: the provider evicted the entry or routed the request elsewhere. |

More in [reports](https://github.com/parthg1901/prefixlens/blob/main/docs/report.md).

## Declaring intentional breaks

A compaction, a revert or a model change the user asked for breaks the prefix on purpose. Declare it, and it is reported as an intentional break, with its cost totalled apart from the misses that point at bugs.

In a test: `assertPrefixStable(prev, next, { allowBreak: "compaction" })`. In a trace: a `prefix_break` hint on the first call after the break.

A declaration excuses one call, and only a change its reason allows. See [intentional breaks](https://github.com/parthg1901/prefixlens/blob/main/docs/intentional-breaks.md).

## Limits

- It sees the request your code sends, not what the provider does with it. Server-side context editing, eviction and routing show up as a miss with the prefix intact.
- Costs are API list prices from a bundled table, not your bill. Subscriptions, discounts and batch tiers are not applied, and the table can be out of date. See [pricing](https://github.com/parthg1901/prefixlens/blob/main/docs/pricing.md).
- Gemini's native API and WebSocket transports are not recorded. Chat Completions streams are recorded only when they report usage (`stream_options: {"include_usage": true}`).
- A trace holds your prompts, tool output and the files your agent read. Keep it private and never commit it. See [SECURITY.md](SECURITY.md).
- The fields of `report --json` may change in a minor version before 1.0. What has been checked on real traffic is listed in [verification](https://github.com/parthg1901/prefixlens/blob/main/docs/verification.md).

## Documentation

- [Assertions](https://github.com/parthg1901/prefixlens/blob/main/docs/assertions.md): `assertPrefixStable`, `explainPrefixDiff`, options, example failures.
- [Proxy](https://github.com/parthg1901/prefixlens/blob/main/docs/proxy.md): options, the base URL to set, lanes and sessions.
- [Library](https://github.com/parthg1901/prefixlens/blob/main/docs/library.md): `wrap`, `createLens`, `buildRecord`, `startProxy`, other exports.
- [Reports](https://github.com/parthg1901/prefixlens/blob/main/docs/report.md): options, the JSON report, how verdicts are decided.
- [Intentional breaks](https://github.com/parthg1901/prefixlens/blob/main/docs/intentional-breaks.md) and [pricing](https://github.com/parthg1901/prefixlens/blob/main/docs/pricing.md).
- [Importers](https://github.com/parthg1901/prefixlens/blob/main/docs/adapters.md): for logs you already have, there are importers for OpenTelemetry GenAI spans and for the session logs of a few coding agents.
- [Trace format](SPEC.md), [security and privacy](SECURITY.md), [changelog](CHANGELOG.md), [development](https://github.com/parthg1901/prefixlens/blob/main/docs/development.md).

## Licence

MIT; see [LICENSE](LICENSE).
