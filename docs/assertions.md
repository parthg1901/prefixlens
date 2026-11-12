# Test assertions

`prefixlens/test` checks, in a unit test, that the request your harness builds for one step keeps the prefix of the request it built for the step before. It compares two request bodies. Nothing is sent to a provider.

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

## `assertPrefixStable` and `explainPrefixDiff`

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

## A failure

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

## Options

| option | meaning |
|---|---|
| `allowBreak` | Declares an intentional break: a reason, or `{ after, reason }`. |
| `ignoreParams` | Parameters to leave out of the comparison, e.g. `["truncation"]`. |
| `hints` | Trace hints that name the change, e.g. `[{ kind: "compaction" }]`. |
| `provider` | The request format, when the body shape is ambiguous. Also picks the parameter rules. |

### `allowBreak`

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

### `ignoreParams`

Use it for a parameter you have shown your provider does not cache on. The built-in rules per provider are in [report.md](report.md#which-request-parameters-count) and [SPEC.md section 8.1](../SPEC.md#81-which-request-parameters-are-part-of-the-cached-prefix).

### `hints`

A `prefix_break`, `compaction` or `model_switch` hint also allows the break, exactly as the report would. So do the hints of `next` when it is a trace record.

### `provider`

A body is read as Anthropic Messages when it has any of:

- a top-level `system`, `thinking`, `stop_sequences`, `cache_control` or `anthropic_version`;
- Anthropic-style tools or content parts;
- a `claude-…` model id, with nothing in the body that only Chat Completions has.

A body with `messages` and none of these is read as Chat Completions. `{ model, max_tokens, messages }` is valid for both APIs, so pass `provider: "anthropic"` for it. A body with `input` or `instructions` is read as OpenAI Responses. Gemini bodies always need `provider: "gemini"`.

## What is compared

- **Deferred tools.** An Anthropic tool sent with `defer_loading: true` is not rendered into the prompt until tool search returns it, so it is not part of the prefix. Adding or removing one is not a change, and block numbers and counts leave such tools out. A trace still lists them, flagged `deferred`.
- **Request-level caching.** A top-level `cache_control` on an Anthropic request is a breakpoint on the last block, not a parameter. Turning it on, or moving to it from a marker on the last message, keeps the prefix.
- **`item_reference` items** (OpenAI Responses, earlier output named by id). They are compared by the id. The item itself is not in the request, so a stable verdict says how many of the unchanged blocks are references whose content and size are unknown (`references`).

## Verdicts on history

| what the harness did | verdict | fix it suggests |
|---|---|---|
| Dropped the oldest messages and replayed the rest (a sliding window) | `2 oldest messages removed from the start of history (3 kept, 2 appended)` | Drop history in chunks at a saved boundary, or keep history append-only. |
| Replaced history with a summary, with or without a tail of recent messages kept word for word | `history compacted (25 → 12 messages from message #1)` | Mark it with `allowBreak: { reason: "compaction" }`. |
| Inserted a message before one already sent, which the SDK merged into it | `1 part inserted at the start of message #1 (user), ahead of content already sent; …` | Append new messages at the end. |
| Rendered a relative date again | `system prompt changed: a relative date value was updated (today → yesterday)` | Keep clocks and ids out of the system prompt: send them in a new message, or round them. |

## Example project

[`examples/ci-prefix-test`](../examples/ci-prefix-test) is a small project whose `bun test` suite catches four common bugs:

- tools sorted differently each turn;
- a timestamp in the system prompt;
- an already-sent message rewritten;
- the tool list changing on a mode switch.

It also shows two legitimate changes passing: `tool_choice: "none"` on the last step, and a declared revert.
