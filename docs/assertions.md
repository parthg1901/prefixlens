# Test assertions

`prefixlens/test` checks, in a unit test, that each request your agent sends keeps the prefix of the request before it. Nothing is sent to a provider.

There are two ways in:

| you have | use |
|---|---|
| a function that builds the request body | [`assertPrefixStable(prev, next)`](#two-requests-assertprefixstable) on two bodies |
| a framework or SDK that builds the request inside (the Vercel AI SDK, Mastra, LangChain, an agent loop) | [`recordRequests()`](#a-whole-run-recordrequests): a stand-in provider that records every request and asserts on all of them |

## Two requests: `assertPrefixStable`

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

In your own test, call the function your harness builds its requests with, in place of `buildRequest`.

### `assertPrefixStable` and `explainPrefixDiff`

`assertPrefixStable(prev, next, options?)` throws a `PrefixBreakError` unless `next` keeps every block of `prev` unchanged, in place, with the same model and cache-relevant parameters. It returns the explanation when the prefix is stable or the change is allowed.

`explainPrefixDiff(prev, next, options?)` returns the same explanation without throwing. Its fields:

| field | holds |
|---|---|
| `stable` | True when `next` keeps every block of `prev`, with the same model and cache-relevant parameters. |
| `ok` | True when stable, or when the change is allowed by `allowBreak`. |
| `appended` | Blocks `next` adds after the unchanged prefix. |
| `unchanged` | Leading blocks that are unchanged. |
| `change` | The first change (`cause`, `summary`, `region`, `detail`, `diff`); `null` when stable. |
| `block` | The first block that differs: its number, kind and label. Absent for model and parameter changes. |
| `allowed` | The reason given in `allowBreak`, when the change was allowed. |
| `references` | How many unchanged blocks are `item_reference` items (see below). |
| `size` | For a change: about how many tokens it re-reads and how many still match, and what the re-read costs when the model has a price. See [the size of a break](#the-size-of-a-break). |
| `fix` | What to do about the change. |
| `message` | The explanation in plain English; the assertion's failure message. |

Neither touches the network. Both give the same answer for the same requests, except that a price can change with the day the test runs (see [the size of a break](#the-size-of-a-break)). A `PrefixBreakError` carries the explanation as `error.explanation`.

`prev` and `next` can be:

- request bodies as sent: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, or Gemini `generateContent` with `provider: "gemini"`;
- canonical requests (`canonicalizeRequest` from `prefixlens`);
- trace records;
- block lists.

### A failure

A failure names the first changed block and what changed, says about how many tokens that re-reads, shows a small diff, and says what to do:

```
PrefixBreakError: prefix not stable: tool order changed (3 of 3 tools moved; same tools, different order)

  first changed block: 1 of 5 (tool "write_file", now tool "read_file"); nothing before it matches, so the whole request is re-read
  size: about 21,000 tokens are re-read (an estimate from the request text); at claude-opus-5-5 list prices that is about $0.08 more than reading them from the cache, each time this happens

    - [0]: write_file
    - [1]: run_shell
    - [2]: read_file
    + [0]: read_file
    + [1]: write_file
    + [2]: run_shell

  fix: build the tool list in a deterministic order (sort it once, e.g. by name) instead of connection or map order.
  if this change is intentional, pass { allowBreak: { reason: "..." } }
```

Control characters in the message are written visibly (`\x1b`), since it ends up in CI logs.

### The size of a break

The `size:` line, and the `size` field of the explanation, say how big a break is. The field holds:

| field | holds |
|---|---|
| `reread` | Tokens the previous request sent from the first changed block on, which this request sends again and cannot read from the cache. A request that is shorter from there, such as one after a compaction, counts only what it sends. |
| `matching` | Tokens before the first changed block. They still match and are read from the cache. |
| `unsized` | Blocks whose size is unknown, which neither figure counts: `item_reference` items, binary data replaced by its hash, blocks a trace records without content. Absent when there are none. |
| `cost` | `{ extra, currency, model }`: what the re-read costs above the cache-read price, at list prices, for this one call. Absent when the model has no price. |

The tokens are an estimate. A request in a test has no provider usage, so they are counted from the request text at four characters of JSON to a token, the rule the test session uses for the usage it reports. A tokenizer gives other numbers, and the line says that it is an estimate. `reread` counts what a report counts as lost tokens ([SPEC.md section 8](../SPEC.md#8-how-prefixlens-analyzes-a-trace-informative)), from the request text instead of the provider's usage.

The price is a report's miss cost for those tokens:

- The model is looked up in the pricing table as in a report: by its id and the request's parameters (`speed: "fast"` selects fast mode), with prompt-size tiers applied. A price that applies only on set days is the one in effect on the day the test runs, or for a trace record, the day it was sent.
- The re-read part up to the request's last cache breakpoint is written to the cache again, so it is priced at the cache-write price. The rest is priced at the input price.
- From that, the cache-read price is taken off, since an unbroken prefix would have been read from the cache.
- A model with no entry gets tokens only, with no note.

It is the cost of one call. A break that happens on every call costs that each time. `assertStable()` gives the size of the first break only. Each call of `session.explain()` carries its own `size`. Nothing is totalled: the conversation in a test is scripted, so a total would measure the test, not your agent.

The pricing table is the one bundled with prefixlens, read from disk once, on the first break. A table that cannot be read gives no price, not an error. `PREFIXLENS_PRICING` and the models.dev catalogue are not used, so the message is the same on every machine. Pass `pricing` to use another table, or `pricing: false` for tokens only.

### Options

| option | meaning |
|---|---|
| `allowBreak` | Declares an intentional break: a reason, or `{ after, reason }`. |
| `ignoreParams` | Parameters to leave out of the comparison, e.g. `["truncation"]`. |
| `hints` | Trace hints that name the change, e.g. `[{ kind: "compaction" }]`. |
| `provider` | The request format, when the body shape is ambiguous. Also picks the parameter rules. |
| `pricing` | The pricing table a break is priced with (`loadPricing()` or `parsePricing()` from `prefixlens`), or `false` for tokens only. Default: the table bundled with prefixlens. |

#### `allowBreak`

`allowBreak` has the same meaning as a `prefix_break` hint in a trace ([intentional-breaks.md](intentional-breaks.md)).

Given a plain string, such as `allowBreak: "revert"`, the reason sets how far the break may reach:

- `"revert"` and `"refusal"` must keep the tools and the system prompt;
- `"compaction"`, `"model_switch"`, `"settings_change"` and any other reason may change anything. A `"compaction"` reason also names the change as one.

Given `{ after, reason }`, the prefix may change only after the position `after`:

| `after` | what must stay |
|---|---|
| `"start"` | Nothing: the change may be anywhere, the model included. |
| `"tools"` | The tools. |
| `"system"` | The tools and the system prompt, e.g. for a compaction that keeps them. |
| `{ system: n }` | The tools and the first n system parts, for a later system part you rewrite on purpose, such as working memory. |
| `{ message: n }` | The tools, the system prompt and messages 1 to n. |
| a number | That many leading blocks. |

Any other value of `after` is an error.

#### `ignoreParams`

Use it for a parameter you have shown your provider does not cache on. The built-in rules per provider are in [report.md](report.md#which-request-parameters-count) and [SPEC.md section 8.1](../SPEC.md#81-which-request-parameters-are-part-of-the-cached-prefix).

#### `hints`

A `prefix_break`, `compaction` or `model_switch` hint also allows the break, exactly as the report would. So do the hints of `next` when it is a trace record.

#### `provider`

A body is read as Anthropic Messages when it has any of:

- a top-level `system`, `thinking`, `stop_sequences`, `cache_control` or `anthropic_version`;
- Anthropic-style tools or content parts;
- a `claude-…` model id, with nothing in the body that only Chat Completions has.

A body with `messages` and none of these is read as Chat Completions. `{ model, max_tokens, messages }` is valid for both APIs, so pass `provider: "anthropic"` for it. A body with `input` or `instructions` is read as OpenAI Responses. Gemini bodies always need `provider: "gemini"`.

### What is compared

- **Deferred tools.** An Anthropic tool sent with `defer_loading: true` is not rendered into the prompt until tool search returns it, so it is not part of the prefix. Adding or removing one is not a change, and block numbers and counts leave such tools out. A trace still lists them, flagged `deferred`.
- **Request-level caching.** A top-level `cache_control` on an Anthropic request is a breakpoint on the last block, not a parameter. Turning it on, or moving to it from a marker on the last message, keeps the prefix.
- **`item_reference` items** (OpenAI Responses, earlier output named by id). They are compared by the id. The item itself is not in the request, so a stable verdict says how many of the unchanged blocks are references whose content and size are unknown (`references`).

### Verdicts on history

| what the harness did | verdict | fix it suggests |
|---|---|---|
| Dropped the oldest messages and replayed the rest (a sliding window) | `2 oldest messages removed from the start of history (3 kept, 2 appended)` | Drop history in chunks at a saved boundary, or keep history append-only. |
| Replaced history with a summary, with or without a tail of recent messages kept word for word | `history compacted (25 → 12 messages from message #1)` | Mark it with `allowBreak: { reason: "compaction" }`. |
| Inserted a message before one already sent, which the SDK merged into it | `1 part inserted at the start of message #1 (user), ahead of content already sent; …` | Append new messages at the end. |
| Rendered a relative date again | `system prompt changed: a relative date value was updated (today → yesterday)` | Keep clocks and ids out of the system prompt: send them in a new message, or round them. |

## A whole run: `recordRequests`

A framework builds the request where a test cannot reach it. A test session takes the provider's place instead: give its `fetch` to the model provider, run the agent as usual, and assert once at the end.

```ts
import { recordRequests } from "prefixlens/test"

const session = recordRequests()                  // no network: it answers every model call itself
const model = createAnthropic({ apiKey: "test", fetch: session.fetch })("claude-sonnet-5-5")
const agent = new Agent({ model, instructions, tools, memory })

await agent.generate("first question")
await agent.generate("second question")

session.assertStable()                            // each request keeps the prefix of the one before it
```

It works with anything that accepts a `fetch` function and sends Anthropic Messages, OpenAI Chat Completions or OpenAI Responses requests: the official SDKs, the Vercel AI SDK providers, and the frameworks built on them. It imports no test runner and touches no globals, so it runs under `node:test`, `bun:test`, vitest and jest.

### What a session does

- **Records.** `session.fetch` keeps the body of every model call exactly as sent. `session.requests` lists them in order, each with its `call` number (from 1), `format`, `lane`, `url`, `body` and, once the test has marked one, its [`step`](#steps).
- **Answers.** Each call gets a reply in its own format's wire shape: JSON, or server-sent events when the request has `stream: true`. Ids, timestamps and usage are the same on every run; usage is estimated from the size of the request (four characters to a token), with nothing read from a cache.
- **Tells conversations apart.** A framework makes side calls between the main ones: a title, a summary, an observer. Each request is put in a lane, and compared only with the request before it in that lane. See [Lanes](#lanes).
- **Refuses what it cannot answer.** A request in another format (an embeddings call, a `count_tokens` call) gets a 404 whose message names the URL, and `assertStable` then throws that message: a model call that was not recorded never passes silently.

### Replies

With no options, every call is answered with the text `OK.`, so an agent's turn ends after one call.

`reply` scripts the model. It is a function of the request, and returns a text, or an object with `text` and/or `toolCalls`:

```ts
const session = recordRequests({
  reply: (request) => (request.call === 1 ? { toolCalls: [{ name: "read_file", args: { path: "src/app.ts" } }] } : "Fixed."),
})
```

`callTools(toolCalls, answer?)` is the script for the usual tool loop: after each user message the model calls the given tools once, and when their results come back it answers (`"Done."` unless you pass another text). A request that offers none of those tools, such as a title generator's, gets the answer straight away.

```ts
const session = recordRequests({ reply: callTools([{ name: "get_weather", args: { city: "Lisbon" } }], "It is 21 degrees.") })
```

### Assertions

`session.assertStable(options?)` compares every call with the one before it in its lane, and throws a `PrefixBreakError` for the first that does not keep the prefix. The message names the call, its lane and the call it is compared with:

```
PrefixBreakError: prefix not stable at call 13 (lane main, compared with call 12): 4 oldest messages removed from the start of history (19 kept, 2 appended)

  first changed block: 3 of 25 (message #1, user); blocks 1-2 still match, everything from block 3 on is re-read
  size: about 9,600 tokens are re-read and about 2,400 still match (an estimate from the request text)

  fix: a window that slides on every call re-reads the whole history each time: drop history in chunks at a saved boundary (cut rarely, and replay from the same cut until the next one), or keep history append-only.
  if this change is intentional, pass { allowBreakAt: { 13: { reason: "..." } } }

  2 more calls change the prefix: call 15 (4 oldest messages removed from the start of history (19 kept, 2 appended)), call 17 (4 oldest messages removed from the start of history (19 kept, 2 appended))
```

It also throws when there was nothing to check: no request was recorded (the provider was not given `session.fetch`), or no lane has a second call.

### Conversations the provider keeps

A harness can let the provider keep the conversation: Anthropic's `thread`, OpenAI's `previous_response_id` or `conversation`. A request that continues one carries only what is new, so it is not meant to extend the request before it, and prefixlens does not compare the two. It does not pass such a call either. `assertStable` throws an `Error` (not a `PrefixBreakError`) that names the calls:

```
Error: prefixlens/test: 14 of the 15 calls were not checked (calls 2-15): each continues a conversation the provider keeps (Anthropic's `thread`), so its request carries only what is new and there is nothing to compare it with.

  Run the agent with that turned off, so that every request carries the conversation in full, and say that the path the provider keeps is not covered by this test.
```

Run the agent for the test with the setting that sends the conversation in full. What the test then covers is the request builder; the path the provider keeps is not covered.

`session.explain()` lists such a call with `notChecked` set to the reason, `ok: false` and `change: null`. A request sent in full after some that were not (a new thread) is compared with the last request that was sent in full. A break in the calls that were compared is reported first. `assertPrefixStable` and `assertSessionStable` do the same for the requests they are given.

`session.explain(options?)` returns the same comparisons without throwing: one [explanation](#assertprefixstable-and-explainprefixdiff) per call that has a call before it, with `call`, `previous` and `lane` added. `assertStable` returns that list when every call is `ok`.

Both take the [options](#options) of `assertPrefixStable` (`allowBreak`, `ignoreParams`, `hints`, `provider`, `pricing`), which apply to every call, and one more:

| option | meaning |
|---|---|
| `allowBreakAt` | Intentional breaks at particular calls: the call number to what [`allowBreak`](#allowbreak) takes. `{ 7: "compaction" }` allows a compaction at call 7 and nowhere else. |

| `allowBreakIn` | Intentional breaks by [step](#steps): the step's name to what `allowBreak` takes. `{ compaction: "compaction" }` allows one break in the step `compaction`. |

A compaction is allowed once, where it happens, so prefer `allowBreakAt` or `allowBreakIn` to `allowBreak` in a session. The call number is in the failure message. A number that is not a call, or is the first call of its lane, is an error.

### Steps

A test that covers several changes can name each one. `session.step(name)` marks what the test does next: every call made after it, until the next `step()`, belongs to that step.

```ts
const session = recordRequests()
const agent = createAgent({ fetch: session.fetch })   // your harness

session.step("first question")
await agent.send("Fix the failing test.")
session.step("reload instructions")
await agent.reloadInstructions()
await agent.send("Go on.")
session.step("compaction")
await agent.compact()
await agent.send("And now?")

console.log(session.summary({ allowBreakIn: { compaction: "compaction" } }).text)
session.assertStable({ allowBreakIn: { compaction: "compaction" } })
```

Mark the step just before the action, and send the request that shows the change before you mark the next step. A step that records no call fails `assertStable`: nothing in it was checked.

With steps:

- **Failure messages name the step**: `prefix not stable at call 4 (step "reload instructions", lane main, compared with call 3)`.
- **`explain()` entries** and **`session.requests`** carry `step`. Calls made before the first step have none.
- **`allowBreakIn`** allows a break by step name, so the test does not change when the run shifts by a call.
- **`assertStable` lists every step that breaks** after the first failure's full message:

```
PrefixBreakError: prefix not stable at call 4 (step "reload instructions", lane main, compared with call 3): system prompt changed (part 1 of 1 edited)

  first changed block: 4 of 10 (system part 1); blocks 1-3 still match, everything from block 4 on is re-read

      type: text
    - text: You are a coding agent.
    + text: You are a coding agent. Updated.

  fix: freeze the system prompt for the session and append updated instructions as a new message.
  if this change is intentional, pass { allowBreakIn: { "reload instructions": { reason: "..." } } }

  3 of 6 steps break the prefix:

    step                 calls  result
    reload instructions  4      break at call 4: system prompt changed (part 1 of 1 edited)
    add a tool           7      break at call 7: tool list changed (+1 tool: 3 → 4)
    remove the tool      8      break at call 8: tool list changed (-1 tool: 4 → 3)
```

`session.summary(options?)` gives one result per step and never throws for a change. `summary.steps` holds, for each step, its `step` name, its `calls`, a `status`, the `result` line and its `explanations`. `summary.text` is the table:

```
step                 calls  result
first question       1-2    stable
queue a reminder     3      stable
reload instructions  4      break at call 4: system prompt changed (part 1 of 1 edited)
compaction           5-6    allowed at call 6 (compaction): history compacted (10 → 3 messages from message #1)
add a tool           7      break at call 7: tool list changed (+1 tool: 3 → 4)
remove the tool      8      break at call 8: tool list changed (-1 tool: 4 → 3)
```

The status is one of `break`, `not checked`, `allowed`, `stable`, `nothing to compare` (each call is the first of its lane) and `no calls`, the first that applies. Calls made before the first step are a row of their own, `(no step)`.

#### What `allowBreakIn` allows

A named step allows one break: the first call in the step whose prefix changed, in any lane. Calls in the step that keep the prefix do not use it up, so a summariser call that extends the history before the compaction is fine. A second change in the same step fails, with a message saying which call took the allowance; give that change a step of its own. The reach of the break is set as for [`allowBreak`](#allowbreak). For that call it takes the place of `allowBreak`, and `allowBreakAt` for the same call comes before both.

A name used for several steps gives each of them its own allowance. A name that is not a step, or a step with no call that has an earlier one in its lane, is an error.

### Lanes

A request joins the first of these that applies:

1. the lane whose latest request it extends;
2. else the lane it shares the most leading messages with (an edited message, a changed tool list);
3. else a lane with the same tools and system prompt (a compaction, a sliding window);
4. else a lane whose latest request starts with the same block: the same first tool, or the same first system part (a rewritten system prompt and a rewritten history at once);
5. else it opens a new lane: `main` for the first, then `lane-2`, `lane-3`.

A lane holds requests that can read each other's cache, so a request that changes its tools and its instructions together opens a new one: nothing at its start is the old lane's. An agent whose instructions list its tools does this on every tool change. Such a request is still the conversation's next one, and it re-reads all of it, so it is compared with the latest request of the lane it came from. The failure says so:

```
prefix not stable at call 14 (lane lane-2, compared with call 13 of lane main, whose conversation it carries on): tool order changed (2 of 3 tools moved; same tools, different order)
```

What marks it as that conversation's is a reply it holds: a first user message can be handed to any agent, a reply comes only from the conversation that produced it. The request must also offer tools, as that conversation does. In `explain()` such an entry has `follows`, the lane it is compared with.

So a title generator or a summariser, with its own instructions and no tools, gets a lane of its own, and a request that breaks the agent's prefix is still compared with the agent's previous request.

Two conversations of the same agent look like one whose history was replaced. Record each in its own session, or name them: a request sent with the header `x-prefixlens-lane: <name>` goes in that lane (with the Vercel AI SDK, `createAnthropic({ fetch: session.fetch, headers: { "x-prefixlens-lane": "thread-a" } })`).

### The trace of a session

`session.writeTrace("run.trace.jsonl")` writes the session as a [trace file](../SPEC.md), one full-request record per call, readable by its owner only. `prefixlens report` shows it call by call, and [`prefixlens check`](check.md) passes or fails it the way `assertStable` does. The usage in it is the session's estimate, so costs and hit rates in that report say nothing about a real provider.

### Request bodies you already have

`assertSessionStable(bodies, options?)` is `session.assertStable()` for an array of request bodies in the order they were sent, for a test that already captures them. It finds the lanes the same way, takes the same options, and numbers calls by their position in the array, from 1. Gemini `generateContent` bodies need `provider: "gemini"`.

```ts
import { assertSessionStable } from "prefixlens/test"

assertSessionStable(capturedBodies, { allowBreakAt: { 12: "compaction" } })
```

`steps` names the steps of the bodies: the call number where each step begins, to its name. A step holds every call up to the next one.

```ts
assertSessionStable(capturedBodies, { steps: { 1: "first question", 12: "compaction" }, allowBreakIn: { compaction: "compaction" } })
```

A test in another language does the same from the command line, with no script and no package.json. Write the bodies to a file, as a JSON array or one per line (JSON Lines), and run:

```sh
npx prefixlens check --requests bodies.jsonl --allow-break-at 12=compaction
```

It checks them as `assertSessionStable` does, prints the same failure message, and exits 0 on a pass, 1 on a break and 2 when the bodies cannot be checked (a call that continues a conversation the provider keeps is one such case). `--ignore-params` and `--provider` are the options of the same names. See [request bodies from your own tests](check.md#request-bodies-from-your-own-tests).

### Complete examples

These four tests are [`examples/framework-session-test`](../examples/framework-session-test), which runs them with `bun test`. The official SDKs stand in for a framework.

Anthropic Messages:

```ts
import Anthropic from "@anthropic-ai/sdk"
import { test } from "bun:test"                    // or "node:test", vitest, jest
import { recordRequests } from "prefixlens/test"

test("Anthropic Messages: every step extends the one before it", async () => {
  const session = recordRequests()
  const client = new Anthropic({ apiKey: "test", fetch: session.fetch })

  // Stand-in for your agent: it keeps one history and sends all of it.
  const messages: Anthropic.MessageParam[] = []
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    messages.push({ role: "user", content: question })
    const reply = await client.messages.create({ model: "claude-sonnet-5-5", max_tokens: 1024, system: "You are a coding agent.", messages })
    messages.push({ role: "assistant", content: reply.content })
  }

  session.assertStable()
})
```

OpenAI Responses, streamed:

```ts
import { test } from "bun:test"                    // or "node:test", vitest, jest
import OpenAI from "openai"
import { recordRequests } from "prefixlens/test"

test("OpenAI Responses, streamed: every step extends the one before it", async () => {
  const session = recordRequests()
  const client = new OpenAI({ apiKey: "test", fetch: session.fetch })

  // Stand-in for your agent: it keeps one history and sends all of it.
  const input: OpenAI.Responses.ResponseInput = []
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    input.push({ role: "user", content: question })
    const response = await client.responses.stream({ model: "gpt-5.6", instructions: "You are a coding agent.", store: false, input }).finalResponse()
    input.push({ role: "assistant", content: response.output_text })
  }

  session.assertStable()
})
```

OpenAI Chat Completions:

```ts
import { test } from "bun:test"                    // or "node:test", vitest, jest
import OpenAI from "openai"
import { recordRequests } from "prefixlens/test"

test("OpenAI Chat Completions: every step extends the one before it", async () => {
  const session = recordRequests()
  const client = new OpenAI({ apiKey: "test", fetch: session.fetch })

  // Stand-in for your agent: it keeps one history and sends all of it.
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: "You are a coding agent." }]
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    messages.push({ role: "user", content: question })
    const completion = await client.chat.completions.create({ model: "gpt-5.6", messages })
    messages.push(completion.choices[0]!.message)
  }

  session.assertStable()
})
```

A tool loop, with a compaction allowed at the call where it happens:

```ts
import Anthropic from "@anthropic-ai/sdk"
import { expect, test } from "bun:test"            // or "node:test", vitest, jest
import { callTools, recordRequests } from "prefixlens/test"

test("a tool loop keeps its prefix, and the compaction is allowed at the call where it happens", async () => {
  // After each user message the model calls read_file once; when the result comes back it answers.
  const session = recordRequests({ reply: callTools([{ name: "read_file", args: { path: "src/app.ts" } }], "Done.") })
  const client = new Anthropic({ apiKey: "test", fetch: session.fetch })
  const tools = [{ name: "read_file", description: "Read a file.", input_schema: { type: "object" as const, properties: { path: { type: "string" } } } }]

  // Stand-in for your agent: a tool loop that replaces its history with a summary once it holds eight messages.
  let messages: Anthropic.MessageParam[] = []
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    if (messages.length >= 8) messages = [{ role: "user", content: "Summary: the bug was in src/app.ts and is fixed." }, { role: "assistant", content: "Understood." }]
    messages.push({ role: "user", content: question })
    for (;;) {
      const reply = await client.messages.create({ model: "claude-sonnet-5-5", max_tokens: 1024, system: "You are a coding agent.", tools, messages })
      messages.push({ role: "assistant", content: reply.content })
      const calls = reply.content.filter((part) => part.type === "tool_use")
      if (calls.length === 0) break
      messages.push({ role: "user", content: calls.map((call) => ({ type: "tool_result" as const, tool_use_id: call.id, content: "export const app = 1" })) })
    }
  }

  // Two model calls per question. Call 5 is the first after the compaction: allowed there, and nowhere else.
  expect(session.requests).toHaveLength(6)
  expect(() => session.assertStable()).toThrow(/prefix not stable at call 5 /)
  session.assertStable({ allowBreakAt: { 5: "compaction" } })
})
```

## Example projects

[`examples/framework-session-test`](../examples/framework-session-test) holds the four session tests above.

[`examples/ci-prefix-test`](../examples/ci-prefix-test) is a small project whose `bun test` suite uses `assertPrefixStable` to catch four common bugs:

- tools sorted differently each turn;
- a timestamp in the system prompt;
- an already-sent message rewritten;
- the tool list changing on a mode switch.

It also shows two legitimate changes passing: `tool_choice: "none"` on the last step, and a declared revert.
