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
| `fix` | What to do about the change. |
| `message` | The explanation in plain English; the assertion's failure message. |

Both are pure functions with no network. A `PrefixBreakError` carries the explanation as `error.explanation`.

`prev` and `next` can be:

- request bodies as sent: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, or Gemini `generateContent` with `provider: "gemini"`;
- canonical requests (`canonicalizeRequest` from `prefixlens`);
- trace records;
- block lists.

### A failure

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

Control characters in the message are written visibly (`\x1b`), since it ends up in CI logs.

### Options

| option | meaning |
|---|---|
| `allowBreak` | Declares an intentional break: a reason, or `{ after, reason }`. |
| `ignoreParams` | Parameters to leave out of the comparison, e.g. `["truncation"]`. |
| `hints` | Trace hints that name the change, e.g. `[{ kind: "compaction" }]`. |
| `provider` | The request format, when the body shape is ambiguous. Also picks the parameter rules. |

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

- **Records.** `session.fetch` keeps the body of every model call exactly as sent. `session.requests` lists them in order, each with its `call` number (from 1), `format`, `lane`, `url` and `body`.
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

  fix: a window that slides on every call re-reads the whole history each time: drop history in chunks at a saved boundary (cut rarely, and replay from the same cut until the next one), or keep history append-only.
  if this change is intentional, pass { allowBreakAt: { 13: { reason: "..." } } }

  2 more calls change the prefix: call 15 (4 oldest messages removed from the start of history (19 kept, 2 appended)), call 17 (4 oldest messages removed from the start of history (19 kept, 2 appended))
```

It also throws when there was nothing to check: no request was recorded (the provider was not given `session.fetch`), or no lane has a second call.

`session.explain(options?)` returns the same comparisons without throwing: one [explanation](#assertprefixstable-and-explainprefixdiff) per call that has a call before it, with `call`, `previous` and `lane` added. `assertStable` returns that list when every call is `ok`.

Both take the [options](#options) of `assertPrefixStable` (`allowBreak`, `ignoreParams`, `hints`, `provider`), which apply to every call, and one more:

| option | meaning |
|---|---|
| `allowBreakAt` | Intentional breaks at particular calls: the call number to what [`allowBreak`](#allowbreak) takes. `{ 7: "compaction" }` allows a compaction at call 7 and nowhere else. |

A compaction is allowed once, where it happens, so prefer `allowBreakAt` to `allowBreak` in a session. The call number is in the failure message. A number that is not a call, or is the first call of its lane, is an error.

### Lanes

A request joins the first of these that applies:

1. the lane whose latest request it extends;
2. else the lane it shares the most leading messages with (an edited message, a changed tool list);
3. else a lane with the same tools and system prompt (a compaction, a sliding window);
4. else a lane whose latest request starts with the same block: the same first tool, or the same first system part (a rewritten system prompt and a rewritten history at once);
5. else it opens a new lane: `main` for the first, then `lane-2`, `lane-3`.

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
