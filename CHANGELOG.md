# Changelog

All notable changes to prefixlens are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, a minor version may break compatibility).

No version has been published to a package registry yet. The versions below mark the `version` in `package.json` at each stage of development.

## [Unreleased]

## [0.4.0] - 2026-11-12

Checked against real traffic for the first time: Claude Code, Codex and opencode, through the recording proxy and through their importers (see "Status" in the README for what was run and what was not). Also: privacy defaults, trace format 1.2, current prices with an optional models.dev overlay, and Node.js support.

### Breaking changes

- The package's entry points are built JavaScript: `bin`, `exports` (`.`, `./test`, `./pricing.json`) and `types` point into `dist/`, which `npm run build` (or `bun run build`, or `npm pack`) creates. Running the TypeScript sources from a checkout with Bun (`bun src/cli.ts`, imports of `src/`) works as before; a link to the checkout (`bun link`) now needs a build first.
- `startProxy()` resolves once the proxy is listening, to `{ url, hostname, port, upstream, trace, stop() }`; it no longer returns the Bun server object, and `stop()` returns a promise.
- `Recorder.begin()` returns a pending call whose `finish` is asynchronous; `lens.observe` is unchanged.
- Claude Code traces imported before this version have one system block fewer (the billing-attribution block Claude Code sends but does not log, now written as an `unknown` block), so they do not compare block by block with traces imported now. Re-import old sessions to compare them.
- Identifying request fields (`metadata`, which carries Claude Code's account, device and session ids in `metadata.user_id`; `user`; `safety_identifier`; Codex's `client_metadata`) are left out of recorded params by default, by every recorder and the Claude Code importer; `keepIdentifiers` / `--keep-identifiers` keeps them. A field absent from either of two records is not reported as a parameter change, so a miss caused by changing OpenAI's `user` now reads as one with the prefix intact.
- OpenAI request blocks that carry `prompt_cache_breakpoint` hash without it (it is recorded as `breakpoint`, as `cache_control` is); every other block hashes as before.
- OpenAI's 12-hour cache writes are now charged at `cache_write_12h`, so costs of calls with such writes change.
- A model id ending in `latest` is no longer left without a models.dev price by its name alone: a model is unpriced on purpose only when the pricing table lists it in `exclude` (the bundled table lists Google's `-latest` aliases).
- Codex subagent rollouts are lanes (`subagent:<thread id>`) of their root session instead of sessions of their own.

### Added

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

### Changed

- The Claude Code importer reads a log line by line and keeps message content in the file until the trace is written, and checks each request's digest from the point its base request reached, so its memory follows the largest request instead of the session: on a 102 MB session, 245 MB instead of 1.8 GB, in a ninth of the CPU time, with a byte-identical trace.
- Base64 images, documents, audio and files are written as `"<binary TYPE, N bytes, sha256 …>"` with `"elided": true` on the block. Block hashes are unchanged, so traces written before and after compare equal; a changed image is reported as a changed binary part.
- Trace files and `--html` reports that prefixlens creates are mode 0600, and directories it creates for them 0700; an existing file keeps its mode, with a warning when others can read it. The models.dev cache file is owner-only too.
- The proxy refuses requests with a non-loopback `Host` or with an `Origin` header (403), answers WebSocket handshakes with 426 (Codex then switches to HTTP at once), opens a lane per cache key, and warns at start-up about a non-loopback `--host` or a plain-HTTP upstream on another machine.
- The Claude Code importer writes the system block Claude Code sends first but does not log (its billing-attribution line) as an `unknown` block, and the logged `betas` as the `anthropic-beta` header instead of a param, so its blocks and breakpoints sit where they were sent. Its digest check is described as what it is: a match with the request Claude Code built, not with the bytes sent.
- The opencode importer reads the tables released versions write (checked on databases opencode 1.19.5 wrote), upgraded databases and channel-named database files, times each call from its message's creation, and warns about the title calls opencode does not store.
- A cut-off call is recorded with `"interrupted": true` instead of `source.complete: false`; traces with the old marker from prefixlens's own recorders are still read as interrupted.
- An empty `PREFIXLENS_PRICING` no longer leaves the report's pricing note without a source name.
- `package.json` is marked `private` until the first release, so it cannot be published by accident.

### Fixed

- Two opencode sessions run one after the other through one proxy shared a lane, and the second session's first call was reported as "history compacted · confirmed"; each is now its own session.
- A reported zero cache-write count on OpenAI (the ChatGPT sign-in backend reports one on every call) was read as "nothing was cached", so a real partial miss could show as a hit. Implicit-caching providers (OpenAI, Gemini) now expect the whole previous prompt to be cached whatever write figure they report; a real count can only raise the expectation. Anthropic's zero still means nothing was written.
- The proxy built each record before the client had the end of the response, delaying the last chunk by up to a quarter of a second on long requests. It now hands every byte, the body's end included, to the socket first, canonicalizes each request once, and hashes its blocks one per turn of the event loop so other open streams are not held up.
- Importing a very large Claude Code session could use several gigabytes of memory (more than 4 GB on a 394 MB log before it was stopped).

## [0.3.0] - 2026-11-11

### Added

- Per-provider rules for which request parameters are part of the cached prefix (`PARAM_RULES`, SPEC.md section 8.1), each marked verified, documented or assumed. A parameter not in the table is assumed to count.
- Trace format 1.1: the `prefix_break` hint, with which a harness declares an intentional break (`compaction`, `revert`, `refusal`, `model_switch`, `settings_change`, or its own reason). Declared breaks are reported as intentional and costed separately (`summary.intentional`, `summary.cost.intentional`).
- `buildRecord`, the proxy's own record builder, as a public export with a signature that is stable from 0.3 (inputs may gain optional fields, never lose or change one).

### Changed

- On OpenAI, `tool_choice` is no longer a cache-relevant parameter (measured on the Responses API).
- `summary.misses` and `summary.cost.misses` no longer include declared breaks. A `compaction` or `model_switch` hint now declares a break too.
- `allowBreak` without `after` reaches as far as its reason does: `"revert"` and `"refusal"` now keep the tools and system prompt (they allowed any change before). Pass `{ after: "start", reason }` for the old behaviour.

### Fixed

- `cache_control` is stripped from OpenAI and Gemini tools and system parts as well as Anthropic ones, and non-string `system`/`instructions` values become a block instead of being dropped.
- The CI example resolves `prefixlens` through tsconfig paths instead of a self-referencing file dependency.

## [0.2.0] - 2026-11-11

### Added

- `prefixlens record --provider anthropic|openai`: a local recording proxy that forwards every request unchanged, streams responses through chunk by chunk, and appends one full-request record per model call. Credentials are forwarded and never written. Lanes are assigned by shared prefix, or chosen with `x-prefixlens-lane` and `x-prefixlens-session`.
- The recording library: `wrap(client)` for the official Anthropic and OpenAI TypeScript SDKs, `createLens()` with `lens.fetch()` for any client that takes a fetch function, and `lens.observe({ request, response })` for custom clients.
- `prefixlens/test`: `assertPrefixStable` and `explainPrefixDiff`, pure functions that name the first changed block, with `allowBreak`, `ignoreParams`, `hints` and `provider` options; and `examples/ci-prefix-test`, which catches the four common prefix bugs.
- `codex` and `otel` (OpenTelemetry GenAI spans) importers, both usage-only.
- README sections on the proxy, the library, CI tests, the base URL to set per harness, and the trace's `headers` field.

### Fixed

- OpenAI and Gemini implicit caches are expected in 128-token steps, and a change of `session-id` is named as a cause.

## [0.1.0] - 2026-11-11

### Added

- The trace format (JSON Lines, one record per model call, with ordered and hashed request blocks and a fidelity flag), specified in SPEC.md with hash test vectors and a tested example.
- The canonicalizer, block hashing and the diff engine that finds the first changed block.
- Usage normalization for Anthropic, OpenAI and Gemini, a user-editable pricing table (`pricing.json`), and miss analysis: expected cached tokens, lost tokens, miss cost and cause.
- `prefixlens import claude-code` (full-request on recent Claude Code logs, verified against the request digest Claude Code logs; usage-only on older logs) and `prefixlens import opencode` (usage-only, SQLite or legacy JSON storage).
- `prefixlens report` with a terminal table, `--json`, and a self-contained `--html` report.
- Traces write each block's content once and reuse unchanged leading blocks of the previous call, to keep long sessions small.

### Fixed

- Rewinds, subagent lanes, cache TTL inference, piped output, and the check against the harness's own cost totals.
- A miss is not blamed on a change after the previous call's last cache breakpoint; a quick follow-up miss with an intact prefix is named as provider-side.
- Later system messages keep their place in prefix order.
- Clear CLI errors for missing paths, empty input, non-trace files, unknown options and bad pricing tables.
