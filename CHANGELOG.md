# Changelog

All notable changes to prefixlens are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, a minor version may break compatibility).

No version has been published to a package registry yet. 0.5.0 is to be the first. The entries under "Before the first release" mark the `version` in `package.json` at earlier stages of development, which were never published.

## [Unreleased]

## [0.5.0] - 2026-11-12

Wrong verdicts found on real requests from Mastra, opencode, Claude Code and Codex (see "Status" in the README for what the fixes were checked on). Also: trace format 1.3, and control characters in a trace no longer reach the terminal.

### Added

- A cause for a sliding history window, `oldest_messages_removed` (group "history rewrites"): the next request's history is the previous one's with its oldest messages removed and everything after them replayed. It is reported as `2 oldest messages removed from the start of history (3 kept, 2 appended)`, with the fix "drop history in chunks at a saved boundary, or keep history append-only". It was reported as "message #1 (user) was edited after it was sent". A single message removed from the start of history, with the rest replayed, now has this cause instead of `message_removed`.
- `allowBreak: { after: { system: n } }`, and the same `after` on a `prefix_break` hint: the tools and the first n system parts must stay. A position that is not one of the documented forms is now an error (it was counted as `NaN`, and the break silently allowed nothing).
- The block field `deferred` for an Anthropic tool sent with `defer_loading: true`. Such a tool is recorded but is not part of the prompt prefix: adding or removing one is no longer reported as a tool-list change, and block numbers and counts leave deferred tools out. `prefixBlocks` in the trace module gives the blocks that are compared.
- Trace format 1.3: the `deferred` block field and the `{"system": n}` form of `after` above, both optional, are a minor version of their own, as the format's rule for additions requires (SPEC.md had described them as additions to 1.2). Every 1.0, 1.1 and 1.2 trace is a valid 1.3 trace, and `TRACE_FORMAT_VERSION` is `"1.3"`.
- `turns[].warm_start` and the status label `hit (warm start)`; `summary.cache_steps`; `abandoned_cached_tokens` in a compaction cause's detail (the size of the cache the compaction gave up, also shown under the miss); `also_changed` in an expiry cause's detail; `references` in a `prefixlens/test` explanation; `TraceWriter.lanes()`.
- `erasableSyntaxOnly` in `tsconfig.json`, so the TypeScript sources stay importable under Node's type stripping.

### Changed

- **Expiry outranks a prefix change.** A call that read nothing and was sent later than the cache lifetime after the previous call is an expiry miss: it would have missed with the prefix untouched. A prefix change found as well is named in the summary and reported as the call's `prefix_change`; for usage-only records, what the harness logged (a compaction, pruned tool outputs, a declared break) is named beside the likely expiry. A break declared on such a call no longer makes it an intentional break. A call that read part of the cache is unaffected, since the cache was evidently still there, and a model change still comes first. An expiry now also outranks a changed `session-id` header.
- **Cache step size is learnt from the trace.** The step an implicit cache reads in is no longer assumed to be 128 tokens: per provider and model it is the greatest common divisor of the non-zero cache reads in the trace (from at least four reads with at least two values, never below 128). What a call is expected to read is counted in that step, and with a learnt step a request that exactly extends the previous one is a hit when it is less than one step short. A gateway that reads in steps of 1,088 tokens had most of its good requests flagged as provider-side partial misses.
- **A first call that read from the cache is a hit**, shown as a warm start, not `cold`: an earlier session with the same tools and instructions had left that prefix cached. `summary.status.cold` counts only first calls that read nothing.
- **A compaction that keeps a tail of recent messages is a compaction** (new messages in front, then the rest of the old history unchanged and in order), not an edited first message.
- A miss with every recorded block intact, on a request with a block the trace could not record (the Claude Code importer's billing-attribution block), is still reported as provider-side but as *inferred*, worded "a provider-side miss, or a change in the block the trace does not record"; it no longer says "not caused by the harness".
- Parts put ahead of parts already sent in a message are reported as `message_inserted` ("1 part inserted at the start of message #1 (user), ahead of content already sent"), not as "1 part appended": a message inserted into history reads this way once the SDK has merged it with the next one.
- A relative date rendered again ("today" becoming "yesterday", "2 hours ago" becoming "3 hours ago") is a dynamic value, labelled "relative date", in the system prompt and in messages.
- A top-level `cache_control` on an Anthropic request is recorded as a breakpoint on the last block and left out of `params`; it was a parameter, so turning it on read as "request parameters changed: cache_control". Traces recorded before this still carry it under `params`.
- A request body with no `system` and no tool parts is read as Anthropic Messages when it has `stop_sequences`, a top-level `cache_control`, `anthropic_version`, or a `claude-…` model id and nothing that only Chat Completions has; it was read as Chat Completions, with OpenAI's parameter rules. A body with nothing that tells the two apart is still read as Chat Completions.
- A stable verdict from `prefixlens/test` says how many of the unchanged blocks are OpenAI Responses `item_reference` items, which are compared by id only; a report notes calls that sent them; a reference to another item is named as that instead of as an edited message.
- A recorder opened on a trace that already has records (a proxy restarted with `-o` on the same file) continues the lanes the file holds. Its first call used to open `main` again, where it was compared with whatever that lane held before.
- Control characters in what a trace holds (C0 and C1, except newline and tab) are written visibly, as `\x1b`, by the terminal report, by the diff excerpt of every report form and of a `PrefixBreakError` message, and by the proxy's line per call. A trace holds whatever the agent read, and an escape sequence in it could retitle the terminal, hide or recolour later output, or rewrite lines already printed. The JSON report's other fields and the trace itself keep the content as it was.
- The proxy's refusal of a request with `Origin: null` no longer suggests `--allow-origin null`, which would admit every sandboxed page and local file.
- `scripts/release-check.mjs` refuses a release while `## [Unreleased]` in this file has entries, so a tag cannot publish code its release notes leave out.
- The Claude Code importer imports each model call once when several session files hold it: a resumed or forked conversation starts its file with a copy of the earlier file's lines. The copy in the file that starts earliest is kept; a single file imported alone keeps the calls it copied; a warning says how many copies were left out.

### Fixed

- The TypeScript sources could not be imported under plain Node (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), because five classes declared fields as constructor parameter properties.
- On Bun, the proxy answered a request without a `Host` header (HTTP/1.0) with 500 and a stack trace; it now answers 403, as on Node.

## Before the first release

### 0.4.0 - 2026-11-12

Checked against real traffic for the first time: Claude Code, Codex and opencode, through the recording proxy and through their importers (see "Status" in the README for what was run and what was not). Also: privacy defaults, trace format 1.2, current prices with an optional models.dev overlay, and Node.js support.

#### Breaking changes

- The package's entry points are built JavaScript: `bin`, `exports` (`.`, `./test`, `./pricing.json`) and `types` point into `dist/`, which `npm run build` (or `bun run build`, or `npm pack`) creates. Running the TypeScript sources from a checkout with Bun (`bun src/cli.ts`, imports of `src/`) works as before; a link to the checkout (`bun link`) now needs a build first.
- `startProxy()` resolves once the proxy is listening, to `{ url, hostname, port, upstream, trace, stop() }`; it no longer returns the Bun server object, and `stop()` returns a promise.
- `Recorder.begin()` returns a pending call whose `finish` is asynchronous; `lens.observe` is unchanged.
- Claude Code traces imported before this version have one system block fewer (the billing-attribution block Claude Code sends but does not log, now written as an `unknown` block), so they do not compare block by block with traces imported now. Re-import old sessions to compare them.
- Identifying request fields (`metadata`, which carries Claude Code's account, device and session ids in `metadata.user_id`; `user`; `safety_identifier`; Codex's `client_metadata`) are left out of recorded params by default, by every recorder and the Claude Code importer; `keepIdentifiers` / `--keep-identifiers` keeps them. A field absent from either of two records is not reported as a parameter change, so a miss caused by changing OpenAI's `user` now reads as one with the prefix intact.
- OpenAI request blocks that carry `prompt_cache_breakpoint` hash without it (it is recorded as `breakpoint`, as `cache_control` is); every other block hashes as before.
- OpenAI's 12-hour cache writes are now charged at `cache_write_12h`, so costs of calls with such writes change.
- A model id ending in `latest` is no longer left without a models.dev price by its name alone: a model is unpriced on purpose only when the pricing table lists it in `exclude` (the bundled table lists Google's `-latest` aliases).
- Codex subagent rollouts are lanes (`subagent:<thread id>`) of their root session instead of sessions of their own.

#### Added

- Node.js support: Node 22 or later (the oldest line still supported upstream). Reading opencode's SQLite database needs Node 22.13 or later (built-in SQLite) and decoding zstd request bodies in the proxy Node 22.15 or later; on older Node those two say so. The proxy's server is `node:http` on Node and `Bun.serve` on Bun, and on both every byte of a response, the last included, reaches the client before work on its record starts. A Node test suite (`test-node/`, run on the built package) and `scripts/check-package.mjs`, which packs the package, installs the tarball into temporary projects with npm and with Bun, and uses it there; CI runs both on Node 22.0.0 and 26.
- A release workflow (`.github/workflows/release.yml`): a `v<version>` tag publishes to npm with trusted publishing and provenance and creates a GitHub release from this file, and refuses while `package.json` is private. `docs/releasing.md` has the one-time setup and the checklist.
- Trace format 1.2, all optional and backward compatible (older traces load and read as before): the record fields `interrupted` (a call whose response was cut off; its input-side usage is final, its output a lower bound) and `billing` (`"per_token"` or `"subscription"`), the usage field `cache_write_12h_tokens` (OpenAI's 12-hour writes, from `input_tokens_details.cache_write_tokens_details.ttl_12h_tokens`), the block fields `unknown` (a block known to be sent but not what it held) and `elided` (binary data replaced by its SHA-256 and size), the `tools_changed` hint, and OpenAI's explicit breakpoints.
- OpenAI's explicit cache breakpoints (GPT-5.6 and later): `prompt_cache_breakpoint` on message parts is recorded as `breakpoint`; in explicit-only mode (`prompt_cache_options.mode: "explicit"`) a call is expected to have cached only what it wrote up to its breakpoints, and a change after the last one is not blamed for a miss; `cache_ttl_seconds` follows `prompt_cache_options.ttl` and a breakpoint's own `ttl`. `prompt_cache_options` and `prompt_cache_retention` are classified as not part of the cached prefix.
- The report marks cut-off calls in all three forms and gives output and cost totals as lower bounds when there are any (`turns[].interrupted`, `summary.interrupted`); it words its cost lines by how calls were billed (`summary.billing`).
- The Codex importer names tool-list changes from the hash Codex logs for each tool definition, marks the compaction call, and marks calls made with ChatGPT sign-in as `"billing": "subscription"`; the proxy does the same for the `chatgpt.com` upstream.
- The proxy puts each call in the session its harness names in a request header (`SESSION_HEADERS`: opencode's `x-opencode-session-id`, and `x-opencode-parent-session-id` for a subagent, whose calls become a `subagent:<id>` lane of the root session).
- `keepIdentifiers` and `keepBinary` options for the proxy (`--keep-identifiers`, `--keep-binary`), `wrap`, `createLens` and `buildRecord`; `--allow-origin` / `allowedOrigins` for the proxy.
- `prefixlens pricing update`, `pricing check` and `pricing show`: an optional second source of prices from the [models.dev](https://models.dev) catalogue (MIT licence), fetched only on request into the user cache directory. The pricing table still wins for every model it lists; the catalogue prices models it lacks, a report notes every catalogue-priced model and every figure on which the two sources disagree, and a call needing a price the catalogue lacks (cache read, cache write, 1-hour or 12-hour write) is left unpriced rather than guessed. `report` gains `--no-catalogue` and `--catalogue-provider`; a turn's `priced` can now be `"catalogue"`. The catalogue functions are exported from `prefixlens`.
- Current list prices for OpenAI, Anthropic and Gemini models, with their sources and the day they were checked. In the pricing table: `exclude` (models unpriced on purpose, with a reason), `families` (cache lifetime and minimum by model-id prefix, so a catalogue-priced GPT-5.6 model keeps writes 30 minutes), and `unverified` (fields the provider's page does not print; now also on `gpt-5.5-pro`).
- `ImportOptions.contentOnDemand` and `ImportResult.content`, and the `content` option of `createTraceEncoder` and `serializeTrace`, with which an importer leaves message content in the harness's files until the trace is written.
- MIT licence, `SECURITY.md`, this changelog, and a CI workflow (type-check and tests on Ubuntu and macOS, plus a check that no trace, session log or credential is committed); a "Security and privacy" section in the README, and tests for what the proxy, `wrap`, `lens.fetch`, `lens.observe` and `buildRecord` write and never write.

#### Changed

- The Claude Code importer reads a log line by line and keeps message content in the file until the trace is written, and checks each request's digest from the point its base request reached, so its memory follows the largest request instead of the session: on a 102 MB session, 245 MB instead of 1.8 GB, in a ninth of the CPU time, with a byte-identical trace.
- Base64 images, documents, audio and files are written as `"<binary TYPE, N bytes, sha256 …>"` with `"elided": true` on the block. Block hashes are unchanged, so traces written before and after compare equal; a changed image is reported as a changed binary part.
- Trace files and `--html` reports that prefixlens creates are mode 0600, and directories it creates for them 0700; an existing file keeps its mode, with a warning when others can read it. The models.dev cache file is owner-only too.
- The proxy refuses requests with a non-loopback `Host` or with an `Origin` header (403), answers WebSocket handshakes with 426 (Codex then switches to HTTP at once), opens a lane per cache key, and warns at start-up about a non-loopback `--host` or a plain-HTTP upstream on another machine.
- The Claude Code importer writes the system block Claude Code sends first but does not log (its billing-attribution line) as an `unknown` block, and the logged `betas` as the `anthropic-beta` header instead of a param, so its blocks and breakpoints sit where they were sent. Its digest check is described as what it is: a match with the request Claude Code built, not with the bytes sent.
- The opencode importer reads the tables released versions write (checked on databases opencode 1.19.5 wrote), upgraded databases and channel-named database files, times each call from its message's creation, and warns about the title calls opencode does not store.
- A cut-off call is recorded with `"interrupted": true` instead of `source.complete: false`; traces with the old marker from prefixlens's own recorders are still read as interrupted.
- An empty `PREFIXLENS_PRICING` no longer leaves the report's pricing note without a source name.
- `package.json` is marked `private` until the first release, so it cannot be published by accident.

#### Fixed

- Two opencode sessions run one after the other through one proxy shared a lane, and the second session's first call was reported as "history compacted · confirmed"; each is now its own session.
- A reported zero cache-write count on OpenAI (the ChatGPT sign-in backend reports one on every call) was read as "nothing was cached", so a real partial miss could show as a hit. Implicit-caching providers (OpenAI, Gemini) now expect the whole previous prompt to be cached whatever write figure they report; a real count can only raise the expectation. Anthropic's zero still means nothing was written.
- The proxy built each record before the client had the end of the response, delaying the last chunk by up to a quarter of a second on long requests. It now hands every byte, the body's end included, to the socket first, canonicalizes each request once, and hashes its blocks one per turn of the event loop so other open streams are not held up.
- Importing a very large Claude Code session could use several gigabytes of memory (more than 4 GB on a 394 MB log before it was stopped).

### 0.3.0 - 2026-11-11

#### Added

- Per-provider rules for which request parameters are part of the cached prefix (`PARAM_RULES`, SPEC.md section 8.1), each marked verified, documented or assumed. A parameter not in the table is assumed to count.
- Trace format 1.1: the `prefix_break` hint, with which a harness declares an intentional break (`compaction`, `revert`, `refusal`, `model_switch`, `settings_change`, or its own reason). Declared breaks are reported as intentional and costed separately (`summary.intentional`, `summary.cost.intentional`).
- `buildRecord`, the proxy's own record builder, as a public export with a signature that is stable from the first release (inputs may gain optional fields, never lose or change one).

#### Changed

- On OpenAI, `tool_choice` is no longer a cache-relevant parameter (measured on the Responses API).
- `summary.misses` and `summary.cost.misses` no longer include declared breaks. A `compaction` or `model_switch` hint now declares a break too.
- `allowBreak` without `after` reaches as far as its reason does: `"revert"` and `"refusal"` now keep the tools and system prompt (they allowed any change before). Pass `{ after: "start", reason }` for the old behaviour.

#### Fixed

- `cache_control` is stripped from OpenAI and Gemini tools and system parts as well as Anthropic ones, and non-string `system`/`instructions` values become a block instead of being dropped.
- The CI example resolves `prefixlens` through tsconfig paths instead of a self-referencing file dependency.

### 0.2.0 - 2026-11-11

#### Added

- `prefixlens record --provider anthropic|openai`: a local recording proxy that forwards every request unchanged, streams responses through chunk by chunk, and appends one full-request record per model call. Credentials are forwarded and never written. Lanes are assigned by shared prefix, or chosen with `x-prefixlens-lane` and `x-prefixlens-session`.
- The recording library: `wrap(client)` for the official Anthropic and OpenAI TypeScript SDKs, `createLens()` with `lens.fetch()` for any client that takes a fetch function, and `lens.observe({ request, response })` for custom clients.
- `prefixlens/test`: `assertPrefixStable` and `explainPrefixDiff`, pure functions that name the first changed block, with `allowBreak`, `ignoreParams`, `hints` and `provider` options; and `examples/ci-prefix-test`, which catches the four common prefix bugs.
- `codex` and `otel` (OpenTelemetry GenAI spans) importers, both usage-only.
- README sections on the proxy, the library, CI tests, the base URL to set per harness, and the trace's `headers` field.

#### Fixed

- OpenAI and Gemini implicit caches are expected in 128-token steps, and a change of `session-id` is named as a cause.

### 0.1.0 - 2026-11-11

#### Added

- The trace format (JSON Lines, one record per model call, with ordered and hashed request blocks and a fidelity flag), specified in SPEC.md with hash test vectors and a tested example.
- The canonicalizer, block hashing and the diff engine that finds the first changed block.
- Usage normalization for Anthropic, OpenAI and Gemini, a user-editable pricing table (`pricing.json`), and miss analysis: expected cached tokens, lost tokens, miss cost and cause.
- `prefixlens import claude-code` (full-request on recent Claude Code logs, verified against the request digest Claude Code logs; usage-only on older logs) and `prefixlens import opencode` (usage-only, SQLite or legacy JSON storage).
- `prefixlens report` with a terminal table, `--json`, and a self-contained `--html` report.
- Traces write each block's content once and reuse unchanged leading blocks of the previous call, to keep long sessions small.

#### Fixed

- Rewinds, subagent lanes, cache TTL inference, piped output, and the check against the harness's own cost totals.
- A miss is not blamed on a change after the previous call's last cache breakpoint; a quick follow-up miss with an intact prefix is named as provider-side.
- Later system messages keep their place in prefix order.
- Clear CLI errors for missing paths, empty input, non-trace files, unknown options and bad pricing tables.

[Unreleased]: https://github.com/<owner>/<repo>/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/<owner>/<repo>/releases/tag/v0.5.0
