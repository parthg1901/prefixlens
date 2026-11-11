# prefixlens trace format, version 1

This document specifies the trace format that prefixlens reads. A harness in any language can write it directly; prefixlens's own log adapters write it too. The key words MUST, SHOULD and MAY are used as in RFC 2119.

A trace records the model calls an agent made, one record per call, so that each call can be compared with the call before it. The comparison answers two questions: did the call read from the prompt cache what the previous call left there, and if not, which part of the request changed.

## 1. File

- A trace is a text file in UTF-8. Each line is one JSON object (JSON Lines). Blank lines are ignored.
- Each line describes one model call: one HTTP request to a model API and its response.
- Records SHOULD be written in the order the requests were sent. Readers process records in file order.
- A trace MAY hold several sessions and several lanes (section 7). Records from different lanes MAY be interleaved.
- Writers SHOULD append to the file as calls complete; a trace is valid at every line boundary.
- The suggested file extension is `.trace.jsonl`.

## 2. Record

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | integer | yes | Format version. Always `1` for this document. |
| `ts` | string | yes | When the request was sent, as an RFC 3339 timestamp with a time zone, e.g. `"2026-01-01T10:00:00.000Z"`. Use the request start, not the response end: cache lifetimes run from the start of the request that wrote or read the entry. |
| `provider` | string | yes | Whose caching rules apply: `"anthropic"`, `"openai"` or `"gemini"`. Other values are allowed (e.g. a gateway id); readers then fall back to defaults. For a model reached through a gateway or cloud (Bedrock, Vertex, OpenRouter), use the provider that built the model. |
| `model` | string | yes | Model id as sent in the request, e.g. `"claude-opus-5-5"`. |
| `fidelity` | string | yes | `"full-request"` or `"usage-only"`. See section 5. |
| `usage` | object | yes | Token counts from the response. See section 3. |
| `request` | object | when `fidelity` is `"full-request"` | `{ "reuse"?: integer, "blocks": [Block, ...] }`: the request as ordered blocks (section 4), optionally starting with blocks reused from the previous full request in the same lane (section 4.6). MUST be absent or ignored for `"usage-only"`. |
| `params` | object | no | Every request field that is not the model, tools, system prompt or messages, for example `{"max_tokens": 32000, "thinking": {"type": "adaptive"}, "tool_choice": {"type": "auto"}}`. Leave out transport-only fields (`stream`, `stream_options`). Never include credentials or headers. |
| `id` | string | no | An identifier for the call, unique within the trace (a request id or response id). |
| `session` | string | no | The conversation this call belongs to. |
| `lane` | string | no | A sequence of calls within the session that build on each other, e.g. `"main"` or a subagent id. Default `"main"`. See section 7. |
| `cache_ttl_seconds` | integer | no | Cache lifetime that applied to the prefix this call wrote, in seconds. For Anthropic, the TTL of the last `cache_control` breakpoint: `300` for the default 5 minutes, `3600` for `"ttl": "1h"`. Omit when unknown; readers use the provider default. |
| `hints` | array | no | Facts the harness knows about what happened before this call. See section 6. |
| `source` | object | no | Free-form provenance, e.g. `{"adapter": "claude-code", "version": "2.1.322"}` or `{"harness": "myagent", "version": "0.3.0"}`. Readers do not interpret it. |

Readers MUST ignore fields they do not know. Writers MUST NOT put API keys, auth headers or other credentials in any field.

## 3. Usage

| Field | Type | Required | Meaning |
|---|---|---|---|
| `input_tokens` | integer ≥ 0 | yes | Input tokens that were neither read from nor written to the cache (billed at the base input price). |
| `cache_read_tokens` | integer ≥ 0 | yes | Input tokens read from the cache. |
| `cache_write_tokens` | integer ≥ 0, or `null` | yes | Input tokens written to the cache. `null` when the provider does not report writes (implicit caching: OpenAI, Gemini). Use `0`, not `null`, when an explicit-caching provider wrote nothing. |
| `cache_write_1h_tokens` | integer ≥ 0 | no | The part of `cache_write_tokens` written with a 1-hour TTL (priced differently from 5-minute writes). |
| `output_tokens` | integer ≥ 0 | yes | All billed output tokens, including reasoning. |
| `reasoning_tokens` | integer ≥ 0 | no | The part of `output_tokens` spent on reasoning. |
| `reported_cost` | number ≥ 0 | no | What the harness itself recorded this call cost, in USD. prefixlens prices calls from its own table and shows this only for comparison. |

The prompt size of a call is `input_tokens + cache_read_tokens + (cache_write_tokens or 0)`.

How to fill it from each provider's response:

| Provider | `input_tokens` | `cache_read_tokens` | `cache_write_tokens` | `output_tokens` |
|---|---|---|---|---|
| Anthropic Messages | `usage.input_tokens` (already excludes cache) | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens`; `cache_write_1h_tokens` = `usage.cache_creation.ephemeral_1h_input_tokens` | `usage.output_tokens` |
| OpenAI Chat Completions | `prompt_tokens − prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cached_tokens` | `null` | `completion_tokens`; `reasoning_tokens` = `completion_tokens_details.reasoning_tokens` |
| OpenAI Responses | `input_tokens − input_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` | `null` | `output_tokens`; `reasoning_tokens` = `output_tokens_details.reasoning_tokens` |
| Gemini | `promptTokenCount − cachedContentTokenCount` | `cachedContentTokenCount` | `null` | `candidatesTokenCount + thoughtsTokenCount` |

Anthropic caches only up to explicit `cache_control` breakpoints and reports writes. OpenAI caches prompt prefixes automatically once the prompt is about 1024 tokens or longer, in 128-token steps, and reports only reads. Gemini's implicit caching also reports only reads.

When a streamed response reports usage in several events, record the final totals.

## 4. Blocks

A full request is a list of blocks in the order the provider assembles the prompt prefix. Each block is one tool definition, one part of the system prompt, or one message.

### 4.1 Block object

| Field | Type | Required | Meaning |
|---|---|---|---|
| `kind` | string | yes | `"tool"`, `"system"` or `"message"`. |
| `hash` | string | yes, unless `content` is present | Lowercase hex SHA-256 of the canonical JSON of `content` (section 4.4). Readers compute it when absent. |
| `content` | any JSON value | no | The block as sent, in the canonical form of section 4.3. May be omitted (section 4.5). |
| `key` | string | no | The tool name for tools; the role for messages (`"user"`, `"assistant"`, `"tool"`, ...). Used in explanations only; not hashed. |
| `breakpoint` | boolean | no | `true` when a cache breakpoint (Anthropic `cache_control`) was set on this block or on a part inside it. |

### 4.2 Order

All tool blocks come first, then all system blocks, then all message blocks. Readers MUST reject a record whose blocks are out of that order.

Within each group, blocks keep the order of the request:

| Provider | tool blocks | system blocks | message blocks |
|---|---|---|---|
| Anthropic | each element of `tools` | each element of `system` (a string `system` is one block) | each element of `messages` |
| OpenAI Chat | each element of `tools` (and legacy `functions`) | each leading `messages` element whose role is `system` or `developer` | the other `messages` elements |
| OpenAI Responses | each element of `tools` | `instructions` (one block), then each leading `input` item whose role is `system` or `developer` | the other `input` items |
| Gemini | each entry of `tools[].functionDeclarations`; other tool entries (e.g. `{"googleSearch": {}}`) whole | each part of `systemInstruction.parts` | each element of `contents` |

"Leading" means before the first element with any other role; a system or developer message later in the conversation is a message block, so the order rule holds.

The tools-before-system order matches Anthropic's documented render order (tools, then system, then messages). For OpenAI and Gemini the provider's internal order is not documented; the order above is a convention, and since a change anywhere in the prefix invalidates what follows it, the first changed block still identifies the cause.

### 4.3 Canonical content

`content` is the block as the provider received it, with two normalizations, so that harmless representation changes do not look like edits:

1. **Remove cache markers.** Delete the `cache_control` key from the block object itself and from each element of its `content` array (message parts). Do not delete keys at other depths. Breakpoints move between calls without changing what is cached; record them in `breakpoint` instead.
2. **Use the part form for text.** When a message's `content` is a string, replace it with a one-element array holding a text part: `[{"type": "text", "text": "<string>"}]` for Anthropic and OpenAI Chat; `{"type": "input_text", ...}` (or `"output_text"` for assistant messages) for OpenAI Responses. An Anthropic `system` string becomes one block with content `{"type": "text", "text": "<string>"}`; an OpenAI Responses `instructions` string becomes one block with the same content.

Everything else is kept as sent, including key order (which does not affect the hash) and unknown fields.

### 4.4 Hash

```
hash = lowercase_hex( SHA-256( UTF-8( canonical_json(content) ) ) )
```

`canonical_json` is the JSON Canonicalization Scheme (RFC 8785): no whitespace; object members sorted by key, comparing keys as sequences of UTF-16 code units; strings escaped as ECMAScript `JSON.stringify` escapes them (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\u00XX` for other control characters, everything else literal); numbers in ECMAScript shortest round-trip form (`1`, `1.5`, `1e+21`, `-0` written as `0`). `NaN` and infinities are not allowed.

In JavaScript this is `JSON.stringify` applied to a copy with keys sorted recursively. In Python, `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` gives the same bytes for content without floats that need ECMAScript formatting and without non-BMP keys that sort differently in UTF-16.

Test vectors:

| content | hash |
|---|---|
| `{"a":1}` | `015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862` |
| `{"type":"custom","name":"read_file"}` | `5d364be90495295000470579a9553503093c9e3b7d035f94f0626e24de3693e1` |
| `{"role":"user","content":[{"type":"text","text":"hi"}]}` | `da3ac0b4d79dbe28c3c6684e1e4d037992df0e519e410c56436a23ecadf5c3c1` |

Two blocks are the same if and only if their hashes are equal. When a block carries both `hash` and `content`, readers SHOULD warn if they disagree and use `hash`.

### 4.5 Omitting content

`content` MAY be omitted from a block, leaving `kind`, `hash` and optionally `key` and `breakpoint`:

- **Deduplication.** A writer SHOULD write each distinct block's content only the first time its hash appears in the file, and omit it from later blocks with the same hash. Readers restore omitted content from the earliest earlier line with the same hash. Without this, a full-request trace grows with the square of the conversation length, since each call repeats the whole prefix.
- **Redaction.** A writer MAY omit content it does not want stored (secrets, private code). A hash-only block still locates the first changed block exactly; only the text diff is lost. A writer that redacts MUST still compute the hash over the real canonical content.

A hash-only block whose hash never appears with content is valid; it is treated as redacted.

### 4.6 Reusing the previous request's prefix

Even with content deduplicated, listing every block's hash on every line makes a long session's trace grow with the square of its length. A record MAY therefore set `request.reuse` to a non-negative integer N. Its full block list is then the first N blocks of the previous `"full-request"` record in the same lane (section 7), exactly as that record's blocks were resolved (including `key` and `breakpoint`), followed by the blocks in `request.blocks`.

- "Previous" means the closest earlier line in the file with the same `session` and `lane` and `fidelity: "full-request"`; usage-only records in between are skipped.
- N MUST NOT exceed that record's block count; if there is no such record, N MUST be 0. Readers MUST reject the record otherwise.
- The block-order rule of section 4.2 applies to the resolved list.
- A writer that reuses a block with a different `breakpoint` value than before must list that block instead, since reuse copies the flag. In practice: reuse the longest leading run of blocks whose `hash`, `kind`, `key` and `breakpoint` are all unchanged.
- Omitting `reuse` (or writing 0) and listing every block is always valid.

## 5. Fidelity

- **`"full-request"`**: `request.blocks` lists every tool, system part and message the provider received, in order. With two consecutive full-request records in a lane, a reader can prove whether the earlier request is an unchanged prefix of the later one and name the first block that differs. A writer that rebuilds requests from a log, rather than recording the request it sent, SHOULD write `"full-request"` only when it can show the rebuild is exact (prefixlens's Claude Code importer matches the request digest Claude Code logs), and `"usage-only"` otherwise. Changes a provider makes after receiving the request, such as server-side context editing, are outside the trace.
- **`"usage-only"`**: only the response usage is known (plus `model`, `ts` and optionally `params` and `hints`). Hit rates, lost tokens and costs are exact. The cause of a miss cannot be proven; readers may infer one from a model change, the time gap against the TTL, and hints, and MUST label such causes as inferred.

A trace may mix both. A comparison between a full-request record and a usage-only record is treated as usage-only.

## 6. Hints

Optional facts from the harness's own log, used to explain usage-only misses and to disambiguate full-request diffs. Each hint is `{"kind": "<kind>", "detail": "<optional text>"}`. Attach a hint to the first call made after the event.

| kind | meaning |
|---|---|
| `compaction` | History was summarized or replaced before this call. |
| `compaction_call` | This call is the compaction (summarization) request itself. |
| `tool_output_pruned` | Earlier tool outputs were cleared or shortened in history before this call. |
| `agent_switch` | The agent or mode changed before this call (its tools and system prompt usually differ). `detail` like `"build → plan"`. |
| `model_switch` | The user or harness changed models before this call. |

Readers MUST ignore hint kinds they do not know.

## 7. Lanes and comparison

Each call is compared with the previous call in the same lane, where a lane is identified by (`session`, `lane`). Calls that do not build on each other's prefix, such as concurrent subagents, MUST be put in different lanes, or they will be compared with each other. The first call in a lane is a cold start.

## 8. How prefixlens analyzes a trace (informative)

For a call `c` with previous call `p` in the same lane:

- `prompt(x) = input_tokens + cache_read_tokens + (cache_write_tokens ?? 0)`.
- **Hit rate** of `c` = `cache_read_tokens / prompt(c)`. Trace hit rate = Σ reads / Σ prompts.
- **Expected cached tokens**: what `p` left in the cache. With explicit caching (`p.cache_write_tokens` not null): `p.cache_read_tokens + p.cache_write_tokens`. With implicit caching: `prompt(p)` if it is at least the provider's minimum cacheable size, else 0. The minimum cacheable size (default 1024 tokens) and the default TTL (300 seconds) are set per provider in the pricing table's `providers` section. Capped at `prompt(c)`.
- **Lost tokens** = `max(0, expected − c.cache_read_tokens)`.
- **Status**: `cold` (first in lane); `uncached` (expected below the minimum cacheable size and nothing read); `hit` (lost ≤ tolerance, default 128 tokens); `miss` (read ≤ tolerance); otherwise `partial`.
- **Cost** = Σ tokens × price from a user-editable pricing table (per million tokens, with separate 5-minute and 1-hour write prices). No price is built into the code.
- **Miss cost** = lost tokens × (the average price this call paid per uncached input or cache-write token − the cache-read price).
- **Cause** of a miss or partial miss, when both records are full-request: the first of these that applies:
  1. model changed;
  2. the first differing block is a tool (tools added or removed, same tools reordered, or a definition edited) or a system part (edited; or only a short timestamp/identifier-like span changed);
  3. a cache-relevant param changed (all params except `max_tokens`, `max_output_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `top_k`, `stop`, `stop_sequences`, `metadata`, `user`, `n`, `stream`, `stream_options`);
  4. the first differing block is a message: history truncated, compacted, rewound, a message removed, inserted, reordered, merged with its neighbour or split, a tool output rewritten (truncated or expanded), reasoning blocks changed, a dynamic value updated, or the message otherwise edited;
  5. nothing changed: cache expired if the start-to-start gap exceeds the TTL (`p.cache_ttl_seconds`, else the provider default), otherwise a provider-side miss, which does not blame the harness. A request sent within a few seconds of the call that wrote the cache can miss this way: the new entry is not always readable yet.

## 9. Example

Three calls in one lane. The second extends the first; the third adds a tool, so the cache from the second is lost. Content of repeated blocks is omitted after its first appearance.

```jsonl
{"v":1,"ts":"2026-01-01T10:00:00.000Z","provider":"anthropic","model":"claude-opus-5-5","fidelity":"full-request","session":"s1","lane":"main","params":{"max_tokens":32000},"cache_ttl_seconds":300,"request":{"blocks":[{"kind":"tool","key":"read_file","hash":"30e0dcd015ebdc47cd26068d185bf8c2fa77fa79248383ceabec55c715551030","content":{"name":"read_file","description":"Read a file.","input_schema":{"type":"object"}}},{"kind":"system","hash":"fee3c7ab8de0808c86ac65af7fb2c71887f6b55eda5c4e8794a58a4c1f0e9822","content":{"type":"text","text":"You are a coding agent."},"breakpoint":true},{"kind":"message","key":"user","hash":"913f6ca8015045bfd57dd7baa26a020b5b82096e3fe980fbda697495d4507585","content":{"role":"user","content":[{"type":"text","text":"Fix the bug."}]},"breakpoint":true}]},"usage":{"input_tokens":3,"cache_read_tokens":0,"cache_write_tokens":2100,"output_tokens":120}}
{"v":1,"ts":"2026-01-01T10:00:09.000Z","provider":"anthropic","model":"claude-opus-5-5","fidelity":"full-request","session":"s1","lane":"main","params":{"max_tokens":32000},"cache_ttl_seconds":300,"request":{"blocks":[{"kind":"tool","key":"read_file","hash":"30e0dcd015ebdc47cd26068d185bf8c2fa77fa79248383ceabec55c715551030"},{"kind":"system","hash":"fee3c7ab8de0808c86ac65af7fb2c71887f6b55eda5c4e8794a58a4c1f0e9822","breakpoint":true},{"kind":"message","key":"user","hash":"913f6ca8015045bfd57dd7baa26a020b5b82096e3fe980fbda697495d4507585"},{"kind":"message","key":"assistant","hash":"2359ae584ca07720bc4364a8f6130313f9c48622a57e957db74867071e87157e","content":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"read_file","input":{"path":"a.py"}}]}},{"kind":"message","key":"user","hash":"fd50c03bc418abdadc0b0e89fb640e4bf86d01f1eb465d2041903911afd053ef","content":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"print(1)"}]},"breakpoint":true}]},"usage":{"input_tokens":3,"cache_read_tokens":2100,"cache_write_tokens":160,"output_tokens":80}}
{"v":1,"ts":"2026-01-01T10:00:20.000Z","provider":"anthropic","model":"claude-opus-5-5","fidelity":"full-request","session":"s1","lane":"main","params":{"max_tokens":32000},"cache_ttl_seconds":300,"request":{"blocks":[{"kind":"tool","key":"read_file","hash":"30e0dcd015ebdc47cd26068d185bf8c2fa77fa79248383ceabec55c715551030"},{"kind":"tool","key":"web_fetch","hash":"d19924e6b34eb7bd1fdb88375d0fb37824280385b21a9b7119e6a6c99ff08c87","content":{"name":"web_fetch","description":"Fetch a URL.","input_schema":{"type":"object"}}},{"kind":"system","hash":"fee3c7ab8de0808c86ac65af7fb2c71887f6b55eda5c4e8794a58a4c1f0e9822","breakpoint":true},{"kind":"message","key":"user","hash":"913f6ca8015045bfd57dd7baa26a020b5b82096e3fe980fbda697495d4507585"},{"kind":"message","key":"assistant","hash":"2359ae584ca07720bc4364a8f6130313f9c48622a57e957db74867071e87157e"},{"kind":"message","key":"user","hash":"fd50c03bc418abdadc0b0e89fb640e4bf86d01f1eb465d2041903911afd053ef"},{"kind":"message","key":"assistant","hash":"d0358957456d5970f9f8b9c2a82404c0b9dd6b2381b9941dac19d6b706fe40cc","content":{"role":"assistant","content":[{"type":"text","text":"Fixed."}]}},{"kind":"message","key":"user","hash":"8ce9c6a2aaf41c70bb9a882db326a43a050ec7274e358130c2e13a6660f2aa0d","content":{"role":"user","content":[{"type":"text","text":"Thanks."}]},"breakpoint":true}]},"usage":{"input_tokens":3,"cache_read_tokens":0,"cache_write_tokens":2500,"output_tokens":20}}
```

The hashes are the real SHA-256 of each block's content, so the example can be saved as a file and read by `prefixlens report` as is. prefixlens reports the third call as `turn 3: miss, tool list changed (+1 tool: 1 → 2)`.

A usage-only record needs only the required fields:

```json
{"v":1,"ts":"2026-01-01T10:00:20.000Z","provider":"openai","model":"gpt-4.1","fidelity":"usage-only","lane":"main","usage":{"input_tokens":480,"cache_read_tokens":2048,"cache_write_tokens":null,"output_tokens":95}}
```

## 10. Checklist for harnesses

1. Write one line per model call, after the response, with `ts` set to when the request was sent.
2. Build blocks from the exact request body you sent, after all your own transformations, in the order of section 4.2.
3. Strip `cache_control` (section 4.3), set `breakpoint` where it was, and normalize string message bodies to text parts.
4. Hash with canonical JSON and SHA-256; check your implementation against the test vectors.
5. Write each block's content once per file and hash-only afterwards, or hash-only throughout if you must redact. For long sessions, also set `request.reuse` (section 4.6) instead of repeating the unchanged prefix.
6. Fill `usage` from the final usage of the response (section 3), with `cache_write_tokens: null` for implicit-caching providers.
7. Give concurrent or independent conversations (subagents) their own `lane`.
8. Never write credentials.
