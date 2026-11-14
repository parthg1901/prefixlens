# Library

```ts
import { wrap, createLens, startProxy, buildRecord } from "prefixlens"   // recording
import { assertPrefixStable, recordRequests } from "prefixlens/test"     // tests
import { canonicalizeRequest, comparePrefix, parseTrace, analyze, classifyMisses, renderTerminal } from "prefixlens"
```

The package runs on Node 22 or later and on Bun, ships its type declarations, and has no runtime dependencies. The assertions and the test session are documented in [assertions.md](assertions.md).

There are four ways to record from your own code. They all build the same record, with the same function.

| your harness | use |
|---|---|
| uses the official Anthropic or OpenAI TypeScript SDK | [`wrap(client)`](#wrap) |
| uses a client or framework that accepts a `fetch` function | [`createLens().fetch()`](#lensfetch) |
| makes its own HTTP calls, or you only have the request and the response | [`lens.observe()`](#lensobserve) or [`buildRecord()`](#buildrecord) |
| is not written in JavaScript | the [trace format](#the-trace-format), or the [recording proxy](proxy.md) |

Recording handles three request formats: Anthropic Messages, OpenAI Chat Completions and OpenAI Responses. A call to a gateway or another provider's compatible endpoint is recorded in whichever of the three formats it uses.

## `wrap`

```ts
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { wrap } from "prefixlens"

const anthropic = wrap(new Anthropic())                          // records to $PREFIXLENS_TRACE or ./prefixlens.trace.jsonl
const openai = wrap(new OpenAI(), { trace: "run.trace.jsonl" })
```

`wrap` works with the official TypeScript SDKs (`@anthropic-ai/sdk`, `openai`), streaming and helpers included: `messages.stream()`, `responses.stream()`, `.withResponse()`.

It does not import either SDK. Both send every request through the client's `fetch`, and `wrap` replaces it on the client you pass with one that records and passes every byte through as it arrives. It returns the same client. Wrapping twice records once.

Options, shared by `wrap` and `createLens`:

| option | meaning |
|---|---|
| `trace` | The trace file to append to, or `false` for none. Default `$PREFIXLENS_TRACE`, else `prefixlens.trace.jsonl` in the working directory. |
| `onRecord(record)` | Called with each record after it is written. |
| `onSkip(reason)` | Called when a call is not recorded: an error response, or a stream with no usage. |
| `session` | Session id for every record. |
| `lane` | Lane for every record. Default: assigned by shared prefix, so independent conversations get their own lanes. |
| `keepIdentifiers` | Keep `metadata`, `user`, `safety_identifier` and `client_metadata` in the recorded params. |
| `keepBinary` | Keep base64 images, documents and audio instead of their SHA-256 and size. |

## `lens.fetch`

```ts
import { createLens } from "prefixlens"

const lens = createLens({ trace: "run.trace.jsonl" })
const client = new MyClient({ fetch: lens.fetch() })
```

`lens.fetch(inner?)` returns a fetch that records model calls and changes nothing else. It calls `inner`, by default the global `fetch`. Any client, SDK or framework that accepts a custom `fetch` can use it.

`lens.wrap(client)` is `wrap` with the lens's options, for several clients that share one trace.

## `lens.observe`

For a client with no fetch hook, report each call after its response ends:

```ts
lens.observe({
  request: body,                     // the request body as sent: Responses, Chat Completions or Anthropic Messages
  response: completedEvent,          // final JSON, the parsed stream events, the SSE text, or the final event alone
  startedAt: requestStart,           // cache lifetimes run from the request start
  headers: { "session-id": cacheKey },
})
```

It returns the record, or `undefined` when the response reports no usage. `api`, `lane` and `session` are optional. `observe` makes no network request.

## `buildRecord`

`buildRecord` is the record builder the proxy, `wrap` and `lens.observe` use. Call it to write traces from your own harness that are identical to what the proxy records:

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

`apiFromBody(body)` and `apiFromPath(pathname)` tell which of the three APIs a call is for.

The signature of `buildRecord` is stable: inputs may gain optional fields, never lose or change one.

## `startProxy`

`startProxy(options)` starts the [recording proxy](proxy.md) from code. It resolves once the proxy is listening, to `{ url, hostname, port, upstream, trace, stop() }`.

`provider` (`"anthropic"` or `"openai"`) and `trace` are required. `port` (0 picks a free one), `hostname`, `upstream`, `onRecord`, `onSkip`, `keepIdentifiers`, `keepBinary`, `allowedOrigins` and `onWarning` are optional.

## The trace format

A trace is JSON Lines, one record per model call. A record holds:

- the provider, the model and the request parameters;
- the canonical request as ordered blocks (tools, system parts, each message), with a SHA-256 hash per block;
- the response usage and a timestamp;
- a fidelity flag, `full-request` or `usage-only`.

To keep long sessions small, block content is written once per trace and referenced by hash afterwards, and each call can reuse the unchanged leading blocks of the previous call instead of listing them again. Content can also be left out entirely to redact it.

[SPEC.md](../SPEC.md) defines the format precisely enough to emit from any language, with hash test vectors and a checklist for harnesses.

## Other exports

The main export has the building blocks the CLI uses:

- **Canonicalizing and comparing.** `canonicalizeRequest` (and `canonicalizeAnthropic`, `canonicalizeOpenAI`, `canonicalizeGemini`) turns a provider request body into blocks. `comparePrefix` and `firstDivergence` compare two requests.
- **Traces.** `parseTrace`, `serializeTrace`, `openTraceWriter`, `createTraceEncoder`, `TRACE_FORMAT_VERSION`.
- **Analysis and reports.** `analyze`, `renderTerminal`, `renderJson`, `renderHtml`.
- **The CI check.** `classifyMisses` sorts the calls of an analysis into classes and says whether the trace passes; `renderCheck` and `renderCheckJson` print it. See [check.md](check.md#from-code).
- **Rules.** `PARAM_RULES` and `paramRule` (which parameters count), `BREAK_REASONS` and `declaredBreaks` (intentional breaks), `CAUSE_GROUP`.
- **Pricing.** `loadPricing`, `findPrice`, `costOf`, and the models.dev catalogue functions.
- **Importers.** `ADAPTERS`, `findAdapter`.
