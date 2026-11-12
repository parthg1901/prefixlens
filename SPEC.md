# prefixlens trace format, version 1.2

This document specifies the trace format that prefixlens reads. A harness in any language can write it directly; prefixlens's own log adapters write it too. The key words MUST, SHOULD and MAY are used as in RFC 2119.

**Versions and compatibility.** Records carry the major version in `v`, which is `1` for every 1.x version of this document. A minor version only adds optional fields and hint kinds, so:

- every 1.0 and 1.1 trace is a valid 1.2 trace and reads exactly as before;
- an older reader reads a newer trace, ignoring what it does not know (section 2, section 6). A 1.0 reader will then report a declared intentional break (section 6.1) as an ordinary miss: the trace degrades to what it would have said without the declaration, never to something less safe.

Version 1.2 adds the optional `interrupted` and `billing` record fields (section 2), the block fields `unknown` (section 4.1) and `elided` (binary-data elision, section 4.5), the optional `cache_write_12h_tokens` usage field (section 3), the `tools_changed` hint (section 6), and OpenAI's explicit cache breakpoints (`prompt_cache_breakpoint`, removed from content and recorded as `breakpoint`, section 4.3; `prompt_cache_options`, section 8). A block that carried `prompt_cache_breakpoint` hashes differently than a 1.1 writer that kept the marker would have hashed it; no other block changes.

Version 1.1 adds the `prefix_break` hint (section 6.1), states the canonical form of every `cache_control` marker and of a non-string system prompt (section 4.3), and documents which request parameters each provider caches on (section 8.1).

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
| `v` | integer | yes | Major format version. Always `1` for this document (1.2); see "Versions and compatibility". |
| `ts` | string | yes | When the request was sent, as an RFC 3339 timestamp with a time zone, e.g. `"2026-01-01T10:00:00.000Z"`. Use the request start, not the response end: cache lifetimes run from the start of the request that wrote or read the entry. |
| `provider` | string | yes | Whose caching rules apply: `"anthropic"`, `"openai"` or `"gemini"`. Other values are allowed (e.g. a gateway id); readers then fall back to defaults. For a model reached through a gateway or cloud (Bedrock, Vertex, OpenRouter), use the provider that built the model. |
| `model` | string | yes | Model id as sent in the request, e.g. `"claude-opus-5-5"`. |
| `fidelity` | string | yes | `"full-request"` or `"usage-only"`. See section 5. |
| `usage` | object | yes | Token counts from the response. See section 3. |
| `request` | object | when `fidelity` is `"full-request"` | `{ "reuse"?: integer, "blocks": [Block, ...] }`: the request as ordered blocks (section 4), optionally starting with blocks reused from the previous full request in the same lane (section 4.6). MUST be absent or ignored for `"usage-only"`. |
| `params` | object | no | Every request field that is not the model, tools, system prompt or messages, for example `{"max_tokens": 32000, "thinking": {"type": "adaptive"}, "tool_choice": {"type": "auto"}}`. Leave out transport-only fields (`stream`, `stream_options`). Writers SHOULD also leave out fields that identify a person, account, device or installation and are not model input (section 8.1, "Identifying fields"): `metadata` (Anthropic's `metadata.user_id`, where Claude Code puts its account id, a persistent device id and the session id; OpenAI's developer key-value pairs), `user`, `safety_identifier`, and client metadata such as Codex's `client_metadata` (a copy of its own request headers: an installation id, per-turn ids, local paths); a writer MAY keep them when its user asks. Keep `prompt_cache_key`: it is a cache-routing key (a harness may derive it from a session or user id). Never include credentials or headers. Write parameters as sent, including ones the provider does not cache on: section 8.1 decides which ones matter, so a writer does not need to. A parameter whose value is not known MAY be left out. |
| `id` | string | no | An identifier for the call, unique within the trace (a request id or response id). |
| `session` | string | no | The conversation this call belongs to. |
| `lane` | string | no | A sequence of calls within the session that build on each other, e.g. `"main"` or a subagent id. Default `"main"`. See section 7. |
| `cache_ttl_seconds` | integer | no | Cache lifetime that applied to the prefix this call wrote, in seconds. For Anthropic, the TTL of the last `cache_control` breakpoint: `300` for the default 5 minutes, `3600` for `"ttl": "1h"`. For OpenAI (GPT-5.6 and later), the minimum lifetime the request set: in implicit mode `prompt_cache_options.ttl`; in explicit mode (`prompt_cache_options.mode: "explicit"`) the `ttl` of the last `prompt_cache_breakpoint`, else `prompt_cache_options.ttl`: `1800` for `"30m"`, `43200` for `"12h"`. Omit when unknown; readers use the model's or provider's default. |
| `hints` | array | no | Facts the harness knows about what happened before this call, including intentional breaks it declares. See section 6. |
| `headers` | object of strings | no | Request headers that route the request to a cache or change what is cached, lowercase names, e.g. `{"session-id": "…"}` (OpenAI's ChatGPT sign-in flow routes its prompt cache by `session-id`), `anthropic-beta`, `anthropic-version`, `openai-beta`. Writers MUST write only headers known not to be credentials: never `authorization`, `x-api-key`, cookies or account ids. prefixlens reports a miss with the prefix intact and a changed `session-id` as a routing change, not a provider-side miss. |
| `interrupted` | boolean | no | 1.2. `true` when the response ended before its final event: the client disconnected or the connection broke. `usage` then holds what the response reported before it ended; its input side (`input_tokens`, `cache_read_tokens`, `cache_write_tokens`) MUST be final, and `output_tokens` is a lower bound (Anthropic reports the input side in its first stream event, so a cut-off Anthropic call can be recorded; an OpenAI stream reports usage only at its end, so a cut-off one cannot). A writer that does not have final input-side counts MUST NOT write the record. Readers count the call in hit rates and miss arithmetic as usual and treat its output tokens and cost as lower bounds. Absent means `false`. |
| `billing` | string | no | 1.2. How the call was billed: `"per_token"` (API billing, where list prices are what was charged before discounts) or `"subscription"` (a plan such as a Claude plan or ChatGPT sign-in, where list prices are only a comparison). Set it only when the writer knows; absent means unknown, and readers MUST NOT assume either. |
| `source` | object | no | Free-form provenance, e.g. `{"adapter": "claude-code", "version": "2.1.322"}` or `{"harness": "myagent", "version": "0.3.0"}`. Readers do not interpret it. |

Readers MUST ignore fields they do not know. Writers MUST NOT put API keys, auth headers or other credentials in any field.

## 3. Usage

| Field | Type | Required | Meaning |
|---|---|---|---|
| `input_tokens` | integer ≥ 0 | yes | Input tokens that were neither read from nor written to the cache (billed at the base input price). |
| `cache_read_tokens` | integer ≥ 0 | yes | Input tokens read from the cache. |
| `cache_write_tokens` | integer ≥ 0, or `null` | yes | Input tokens written to the cache, as the provider reported them. `null` when the provider does not report writes (Gemini; OpenAI before GPT-5.6). Use `0`, not `null`, when an explicit-caching provider wrote nothing. A figure from an implicit-caching provider (OpenAI, Gemini) is a billing fact, not a measure of what was cached: section 8. |
| `cache_write_1h_tokens` | integer ≥ 0 | no | The part of `cache_write_tokens` written with a 1-hour TTL (Anthropic; priced differently from 5-minute writes). |
| `cache_write_12h_tokens` | integer ≥ 0 | no | 1.2. The part of `cache_write_tokens` written with a 12-hour lifetime (OpenAI; priced differently from the default 30-minute writes). OpenAI Responses: `input_tokens_details.cache_write_tokens_details.ttl_12h_tokens`. Omit when the provider does not report the split. |
| `output_tokens` | integer ≥ 0 | yes | All billed output tokens, including reasoning. |
| `reasoning_tokens` | integer ≥ 0 | no | The part of `output_tokens` spent on reasoning. |
| `reported_cost` | number ≥ 0 | no | What the harness itself recorded this call cost, in USD. prefixlens prices calls from its own table and shows this only for comparison. |

The prompt size of a call is `input_tokens + cache_read_tokens + (cache_write_tokens or 0)`.

How to fill it from each provider's response:

| Provider | `input_tokens` | `cache_read_tokens` | `cache_write_tokens` | `output_tokens` |
|---|---|---|---|---|
| Anthropic Messages | `usage.input_tokens` (already excludes cache) | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens`; `cache_write_1h_tokens` = `usage.cache_creation.ephemeral_1h_input_tokens` | `usage.output_tokens` |
| OpenAI Chat Completions | `prompt_tokens − prompt_tokens_details.cached_tokens − prompt_tokens_details.cache_write_tokens` | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` when the response has the field (zero included), else `null` | `completion_tokens`; `reasoning_tokens` = `completion_tokens_details.reasoning_tokens` |
| OpenAI Responses | `input_tokens − input_tokens_details.cached_tokens − input_tokens_details.cache_write_tokens` | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` when the response has the field (zero included), else `null` | `output_tokens`; `reasoning_tokens` = `output_tokens_details.reasoning_tokens` |
| Gemini | `promptTokenCount − cachedContentTokenCount` | `cachedContentTokenCount` | `null` | `candidatesTokenCount + thoughtsTokenCount` |

Anthropic caches only up to explicit `cache_control` breakpoints and reports writes; a response without `cache_creation_input_tokens` wrote nothing. OpenAI caches prompt prefixes automatically once the prompt is about 1024 tokens or longer, in 128-token steps; it reports reads, and from GPT-5.6 on, which bills cache writes, also writes. Some OpenAI backends report a write field that is always zero (the ChatGPT sign-in backend does, while caching normally); record it as reported. Gemini's implicit caching reports only reads.

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
| `breakpoint` | boolean | no | `true` when a cache breakpoint (Anthropic `cache_control`, OpenAI `prompt_cache_breakpoint`) was set on this block or on a part inside it. |
| `elided` | boolean | no | 1.2. `true` when binary data inside `content` was replaced by its digest and size (section 4.5). `hash` is then still that of the content as sent, and is required. |
| `unknown` | boolean | no | 1.2. `true` when the writer knows that a block was sent at this position but not what it held. `hash` is then a placeholder rather than a SHA-256 (e.g. `"unknown:claude-code-billing-attribution"`), the same on every record for which the writer cannot tell the block apart, and `content` MUST be absent; `key` MAY name what the block is. Placing it keeps every other block, and every breakpoint, at the position it was sent at, so a trace from this writer and one from a recorder of the same call agree on every block but this one. A change confined to an unknown block cannot be seen: a miss it caused reads as one with the prefix intact. |

### 4.2 Order

All tool blocks come first, then all system blocks, then all message blocks. Readers MUST reject a record whose blocks are out of that order.

Within each group, blocks keep the order of the request:

| Provider | tool blocks | system blocks | message blocks |
|---|---|---|---|
| Anthropic | each element of `tools` | each element of `system` (a string `system` is one block) | each element of `messages` |
| OpenAI Chat | each element of `tools` (and legacy `functions`) | each leading `messages` element whose role is `system` or `developer` | the other `messages` elements |
| OpenAI Responses | each element of `tools` | `instructions` (one block, absent when `instructions` is absent or `null`), then each leading `input` item whose role is `system` or `developer` | the other `input` items |
| Gemini | each entry of `tools[].functionDeclarations`; other tool entries (e.g. `{"googleSearch": {}}`) whole | each part of `systemInstruction.parts` | each element of `contents` |

"Leading" means before the first element with any other role; a system or developer message later in the conversation is a message block, so the order rule holds.

The tools-before-system order matches Anthropic's documented render order (tools, then system, then messages). For OpenAI and Gemini the provider's internal order is not documented; the order above is a convention, and since a change anywhere in the prefix invalidates what follows it, the first changed block still identifies the cause.

### 4.3 Canonical content

`content` is the block as the provider received it, with two normalizations, so that harmless representation changes do not look like edits:

1. **Remove cache markers.** Delete the `cache_control` key from the block object itself and from each element of its message parts (the `content` array; for Gemini, the `parts` array). Do not delete keys at other depths. Breakpoints move between calls without changing what is cached; record them in `breakpoint` instead. This applies to every block of every provider: tools, system parts and messages alike. Only Anthropic defines `cache_control`, but OpenAI-compatible gateways accept the same marker in OpenAI-format bodies (on tools as well as messages) and forward it, and it moves between calls in the same way. A marker left in would make a moved breakpoint read as an edited tool or message.
   OpenAI's explicit breakpoints are removed the same way: delete `prompt_cache_breakpoint` from an OpenAI message or input item and from each element of its `content` array and, for a Responses `function_call_output`, of its `output` array, and record it in `breakpoint`. OpenAI documents the marker on content parts of input messages in the Responses API (not on `instructions` or tools); its SDK types also allow it on Chat Completions content parts, which are treated alike.
2. **Use the part form for text.** When a message's `content` is a string, replace it with a one-element array holding a text part: `[{"type": "text", "text": "<string>"}]` for Anthropic and OpenAI Chat; `{"type": "input_text", ...}` (or `"output_text"` for assistant messages) for OpenAI Responses. An Anthropic `system` string becomes one block with content `{"type": "text", "text": "<string>"}`; an OpenAI Responses `instructions` string becomes one block with the same content.
3. **Keep undocumented system forms whole.** An Anthropic `system` or OpenAI Responses `instructions` that is `null` or absent gives no block. One that is neither a string nor (for Anthropic `system`) an array is not a documented form; it becomes one system block whose content is the value as sent. It is never dropped: the provider received it, so a change to it must show.

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

- **Binary data.** A writer SHOULD replace the base64 data of images, documents, audio and files inside `content` with a string `"<binary MEDIA_TYPE, N bytes, sha256 HEX>"` (`MEDIA_TYPE` is omitted when the part does not name one; `N` is the size of the decoded bytes; `HEX` is the lowercase hex SHA-256 of the base64 text as sent), and set `"elided": true` on the block. The block's `hash` MUST still be computed over the content as sent, so a block written this way and the same block written in full have the same hash and compare equal, and a changed image still changes it. The parts are, per provider: an Anthropic part whose `source` has `"type": "base64"` (`source.data`; images and documents, also inside `tool_result` content); OpenAI Responses `input_image` (`image_url` when it is a `data:` URL) and `input_file` (`file_data`); Chat Completions `image_url` (`image_url.url`, a `data:` URL), `input_audio` (`input_audio.data`) and `file` (`file.file_data`); Gemini `inlineData` (`data`). A URL that is not a `data:` URL is not binary data and is kept. Readers MUST NOT check `hash` against the content of an `elided` block, and MAY name a change in such a block by the digests.

A hash-only block whose hash never appears with content is valid; it is treated as redacted.

### 4.6 Reusing the previous request's prefix

Even with content deduplicated, listing every block's hash on every line makes a long session's trace grow with the square of its length. A record MAY therefore set `request.reuse` to a non-negative integer N. Its full block list is then the first N blocks of the previous `"full-request"` record in the same lane (section 7), exactly as that record's blocks were resolved (including `key` and `breakpoint`), followed by the blocks in `request.blocks`.

- "Previous" means the closest earlier line in the file with the same `session` and `lane` and `fidelity: "full-request"`; usage-only records in between are skipped.
- N MUST NOT exceed that record's block count; if there is no such record, N MUST be 0. Readers MUST reject the record otherwise.
- The block-order rule of section 4.2 applies to the resolved list.
- A writer that reuses a block with a different `breakpoint` value than before must list that block instead, since reuse copies the flag. In practice: reuse the longest leading run of blocks whose `hash`, `kind`, `key` and `breakpoint` are all unchanged.
- Omitting `reuse` (or writing 0) and listing every block is always valid.

## 5. Fidelity

- **`"full-request"`**: `request.blocks` lists every tool, system part and message the provider received, in order. With two consecutive full-request records in a lane, a reader can prove whether the earlier request is an unchanged prefix of the later one and name the first block that differs. A writer that rebuilds requests from a log, rather than recording the request it sent, SHOULD write `"full-request"` only when it can show the rebuild is exact, marking any block it knows was sent but cannot rebuild as `unknown` (section 4.1), and `"usage-only"` otherwise. prefixlens's Claude Code importer matches the digest Claude Code logs of each request as Claude Code built it, which proves the tools, the logged system parts, the messages, the parameters and the breakpoints; Claude Code's transport then adds a first system block it does not log (a billing-attribution line that differs per session), which the importer writes as an unknown block, and sends the logged `betas` parameter as the `anthropic-beta` header, which the importer writes in `headers`. Changes a provider makes after receiving the request, such as server-side context editing, are outside the trace.
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
| `model_switch` | The user or harness changed models before this call. Also declares an intentional break (section 6.1). |
| `prefix_break` | The harness broke its own prefix on purpose before this call. Version 1.1; section 6.1. |
| `tools_changed` | The tool list sent with this call differs from the previous call's in its lane: tools added, removed, or a definition changed. `detail` names them, e.g. `"+1 tool (web_search); 2 → 3 tools"`. For usage-only writers that know the tool list by name and hash without knowing the request (the Codex importer). Version 1.2. |

A `compaction` hint also declares an intentional break (section 6.1). `agent_switch`, `tools_changed`, `tool_output_pruned` and `compaction_call` only name what happened: a mode switch that changes the tool list, or a pruned tool output, is the kind of change prefixlens exists to find, so it stays a miss unless the harness declares it with `prefix_break`.

Readers MUST ignore hint kinds they do not know.

### 6.1 Declaring an intentional break

A harness sometimes breaks its prefix on purpose: it compacts history and rebuilds its instructions, the user reverts to an earlier point, a refused exchange is left out of history, the user picks another model or reasoning effort. The miss that follows is real and costs money, but it is not a bug. The harness declares it on the first call after the event with a `prefix_break` hint:

```json
{"kind": "prefix_break", "reason": "revert", "detail": "reverted to message 12"}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `kind` | string | yes | `"prefix_break"`. |
| `reason` | string | yes | Why. One of the reasons below, or another short word. |
| `after` | `"start"`, `"tools"`, `"system"`, `{"system": n}`, `{"message": n}`, or an integer ≥ 0 | no | The last part of the previous request that the break leaves unchanged: nothing (`"start"`), the tools, the tools and system prompt, the tools and the first n system parts (`{"system": n}`, for a harness that rewrites a later system part on purpose, such as working memory; an n beyond the system prompt keeps all of it), the tools and system prompt plus messages 1..n, or the first n blocks. Default: set by `reason`, below. |
| `detail` | string | no | Free text for people, e.g. `"high → low"`. |

| `reason` | for | default `after` |
|---|---|---|
| `compaction` | history summarized or replaced (the harness may rebuild its instructions and tools with it) | `"start"` |
| `revert` | the conversation was rewound to an earlier point | `"system"` |
| `refusal` | a refused exchange was left out of history | `"system"` |
| `model_switch` | the model changed | `"start"` |
| `settings_change` | a request parameter changed on purpose, e.g. reasoning effort or thinking at the user's request | `"start"` |
| any other value | | `"start"` |

The older kinds keep working: a `compaction` hint declares `{"reason": "compaction", "after": "start"}` and a `model_switch` hint declares `{"reason": "model_switch", "after": "start"}`.

**Reach.** A declaration applies to the call that carries it, and to nothing else:

- It excuses that call's miss only when the first change, as section 8 finds it between this call and the previous one in its lane, starts at or after the part `after` keeps. The start of a model change is the first block; of a parameter change, the first block of the part section 8.1 says it invalidates; otherwise the first block that differs. A `revert` (after `"system"`) that also changed the tool list is not excused.
- It does not excuse a miss with the prefix intact (an expiry or a provider-side miss): the break did not cause it.
- It does not reach the next call. A second miss right after a declared break is compared with the call that carried the declaration, and is a miss.
- When either of the two records is usage-only, where the prefix changed cannot be checked; the declaration is taken at its word and the report says it was not checked.

**What a reader does with it.** An excused miss is still a miss of the cache: its status, lost tokens and cost are reported as for any other call. It is reported as an *intentional break* with its declared reason and the change found, and its cost is totalled separately from avoidable misses, so a declaration can move a cost from one total to the other but never hide it. A declaration that does not excuse the miss is reported with the miss, saying why.

A malformed `prefix_break` hint (no `reason`, or an invalid `after`) MUST NOT excuse anything; prefixlens drops it with a warning. This is also what a reader older than a form of `after` does with it (`{"system": n}` was added after the first 1.2 readers): the miss is reported as one, never excused by a position the reader does not know.

The same rules decide `assertPrefixStable`'s `allowBreak` option in `prefixlens/test`: `allowBreak: "revert"` allows exactly what a `{"kind": "prefix_break", "reason": "revert"}` hint excuses, and `allowBreak: { after: { system: 1 }, reason: "working memory" }` what the same `after` on a hint does. An `after` there that is not one of the forms above is an error, not a break that allows nothing.

## 7. Lanes and comparison

Each call is compared with the previous call in the same lane, where a lane is identified by (`session`, `lane`). Calls that do not build on each other's prefix, such as concurrent subagents, MUST be put in different lanes, or they will be compared with each other. The first call in a lane is a cold start.

## 8. How prefixlens analyzes a trace (informative)

For a call `c` with previous call `p` in the same lane:

- `prompt(x) = input_tokens + cache_read_tokens + (cache_write_tokens ?? 0)`.
- **Hit rate** of `c` = `cache_read_tokens / prompt(c)`. Trace hit rate = Σ reads / Σ prompts.
- **Expected cached tokens**: what `p` left in the cache. With explicit caching (provider `anthropic`; `openai` when `p.params.prompt_cache_options.mode` is `"explicit"`, which caches only up to the breakpoints a request sets and nothing without one; or a provider other than `openai` and `gemini` whose `p.cache_write_tokens` is not null): `p.cache_read_tokens + p.cache_write_tokens`. With implicit caching (`openai`, `gemini`, or any provider with `p.cache_write_tokens` null): `prompt(p)` rounded down to a multiple of 128 tokens (the step OpenAI caches in) if it is at least the provider's minimum cacheable size, else 0; or `p.cache_read_tokens + p.cache_write_tokens` if that is larger. An implicit-caching provider's write figure can raise the expectation but never lower it: a reported zero does not mean the uncached part of `p` was left out of the cache. The minimum cacheable size (default 1024 tokens) and the default TTL (300 seconds) are set per provider in the pricing table's `providers` section. Capped at `prompt(c)`.
- **Lost tokens** = `max(0, expected − c.cache_read_tokens)`.
- **Status**: `cold` (first in lane); `uncached` (expected below the minimum cacheable size and nothing read); `hit` (lost ≤ tolerance, default 128 tokens); `miss` (read ≤ tolerance); otherwise `partial`.
- **Intentional breaks**: a miss or partial miss excused by a declaration (section 6.1) is reported as an intentional break, counted and costed apart from misses. The **miss** count and miss cost of a trace cover only the others.
- **Cost** = Σ tokens × price from a user-editable pricing table (per million tokens, with separate 5-minute and 1-hour write prices). No price is built into the code.
- **Miss cost** = lost tokens × (the average price this call paid per uncached input or cache-write token − the cache-read price).
- **Cause** of a miss or partial miss, when both records are full-request: the first of these that applies:
  1. model changed;
  2. the first differing block is a tool (tools added or removed, same tools reordered, or a definition edited) or a system part (edited; or only a short timestamp/identifier-like span changed);
  3. a cache-relevant param changed, by the rules of section 8.1 for the record's `provider`;
  4. the first differing block is a message: history truncated, compacted, rewound, a message removed, inserted, reordered, merged with its neighbour or split, a tool output rewritten (truncated or expanded), reasoning blocks changed, a dynamic value updated, or the message otherwise edited;
  5. nothing changed, or, with explicit caching, the first change comes after the last block of `p` marked `breakpoint` (the part `p` cached is intact): cache expired if the start-to-start gap exceeds the TTL (`p.cache_ttl_seconds`, else the provider default), otherwise a provider-side miss, which does not blame the harness. A request sent within a few seconds of the call that wrote the cache can miss this way: the new entry is not always readable yet.

### 8.1 Which request parameters are part of the cached prefix

A parameter is classified by its top-level request key, per provider. *Verified* means measured against the live API; *documented* means the provider's prompt-caching documentation says so; *assumed* means neither, with the reasoning given. A parameter not in the table is assumed cache-relevant from the start of the request, so that a change is never silently ignored; `assertPrefixStable` takes `ignoreParams` for one you have shown is not.

| provider | parameter | in the cached prefix? | a change invalidates | evidence |
|---|---|---|---|---|
| all | `max_tokens`, `max_output_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `top_k`, `stop`, `stop_sequences`, `n`, `seed`, `logprobs`, `top_logprobs`, `metadata` | no | | assumed: sampling and output limits apply after the prompt is read, and no provider lists them as affecting the cache. `user` is in this row for every provider except OpenAI |
| anthropic | `tool_choice` | yes | messages only | documented ("What invalidates the cache": changes to `tool_choice` only affect message blocks) |
| anthropic | `thinking` | yes | everything (messages always; tools and system on models that render it first) | documented |
| anthropic | `output_config` (`effort`) | yes | everything, as `thinking` | documented for `effort`; assumed for the rest of `output_config` |
| anthropic | `speed` | yes | system and messages | documented |
| anthropic | `context_management`, `mcp_servers` | yes | everything | assumed: they change what the model reads (server-side context edits, extra tools) |
| anthropic | `service_tier` | no | | assumed: billing and capacity only |
| openai | `tool_choice` | **no** | | **verified on the Responses API**: a warm 5,159-token prefix read 4,992 cached tokens with `"auto"`, again with `"none"` and the tool list unchanged, and again after switching back. Assumed the same on Chat Completions, consistent with OpenAI's advice to set `tool_choice: "none"` rather than remove tools |
| openai | `parallel_tool_calls`, `reasoning` (`effort`), `text` (`verbosity`, `format`), `context_management` | yes | everything (they change hidden instructions ahead of the prompt) | documented ("Which settings affect the cached prefix?") |
| openai | `reasoning_effort`, `verbosity`, `response_format` | yes | everything | assumed: the Chat Completions names of the documented Responses settings |
| openai | `prompt_cache_key` | yes | everything | documented: keys route requests to a cache |
| openai | `prompt_cache_options`, `prompt_cache_retention` | no | | assumed: they choose which breakpoints are written (`mode`), their minimum lifetime (`ttl`), diagnostics (`comparison_response_id`, new on every call) and a maximum retention; a read still needs the rendered prefix to match. The mode does change what can be read: in explicit-only mode a request reads only at boundaries it marks itself (OpenAI checks "the first 2 and latest 50 explicit breakpoints" of the request), so a call that drops the previous call's breakpoint misses with the prefix intact; prefixlens reports that as a provider-side miss, as it does for Anthropic breakpoints beyond the lookback window |
| openai | `user` | yes | everything | documented: the API reference says `user` is used to bucket similar requests for cache hits, and deprecates it in favour of `prompt_cache_key` |
| openai | `store`, `include`, `service_tier`, `safety_identifier`, `background` | no | | assumed: storage, response fields, billing or delivery only |
| gemini | everything but the common rows (`generationConfig`, `toolConfig`, `cachedContent`, ...) | yes | everything | assumed |

**Identifying fields.** `metadata`, `user`, `safety_identifier` and `client_metadata` identify a person, account, device or installation and are not model input; writers SHOULD leave them out of `params` (section 2). When one of them is absent from either of two records, a reader MUST NOT report it as changed: absent means not recorded, not removed. Of these, only OpenAI's `user` is a cache-routing key, so a trace written without it cannot show that a change of `user` caused a miss; such a miss reads as one with the prefix intact. A writer that needs it keeps the field (prefixlens: `keepIdentifiers`, `--keep-identifiers`).

Classifications are by provider, not by API: OpenAI's Chat Completions and Responses APIs use different names for most settings, and where they share one (`tool_choice`), the Responses measurement is applied to both, as stated. A provider not listed (a gateway id) gets the common rows and the default.

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
8. When you break your own prefix on purpose (compaction, revert, refused exchange left out, model or setting changed at the user's request), add a `prefix_break` hint with its `reason` to the next call (section 6.1). Do not declare anything else: a declaration excuses only the call it is on, and only a change where its reason allows.
9. Never write credentials. If a header routes your requests to a cache (`session-id`), record it in `headers`.
