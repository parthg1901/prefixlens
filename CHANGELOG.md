# Changelog

All notable changes to prefixlens are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, a minor version may break compatibility).

No version has been published to a package registry yet. The versions below mark the `version` in `package.json` at each stage of development.

## [Unreleased]

### Added

- Trace format 1.2, all optional and backward compatible (older traces load and read as before): the record fields `interrupted` (a call whose response was cut off; its input-side usage is final, its output a lower bound) and `billing` (`"per_token"` or `"subscription"`), the usage field `cache_write_12h_tokens` (OpenAI's 12-hour writes, from `input_tokens_details.cache_write_tokens_details.ttl_12h_tokens`), the block fields `unknown` (a block known to be sent but not what it held) and `elided` (binary data replaced by its SHA-256 and size), and the `tools_changed` hint.
- The report marks cut-off calls in all three forms and gives output and cost totals as lower bounds when there are any (`turns[].interrupted`, `summary.interrupted`); it words its cost lines by how calls were billed (`summary.billing`).
- The Codex importer names tool-list changes from the hash Codex logs for each tool definition, and marks calls made with ChatGPT sign-in as `"billing": "subscription"`; the proxy does the same for the `chatgpt.com` upstream.
- `keepIdentifiers` and `keepBinary` options for the proxy (`--keep-identifiers`, `--keep-binary`), `wrap`, `createLens` and `buildRecord`; `--allow-origin` / `allowedOrigins` for the proxy.

- MIT licence, `SECURITY.md`, this changelog, and a CI workflow (type-check and tests on Ubuntu and macOS, plus a check that no trace, session log or credential is committed).
- A "Security and privacy" section in the README, and tests for what the proxy, `wrap`, `lens.fetch`, `lens.observe` and `buildRecord` write and never write.
- `prefixlens pricing update`, `pricing check` and `pricing show`: an optional second source of prices from the [models.dev](https://models.dev) catalogue (MIT licence), fetched only on request into the user cache directory. The pricing table still wins for every model it lists; the catalogue prices models it lacks, a report notes every catalogue-priced model and every figure on which the two sources disagree, and a call needing a price the catalogue lacks (cache read, cache write, 1-hour write) is left unpriced rather than guessed. `report` gains `--no-catalogue` and `--catalogue-provider`; a turn's `priced` can now be `"catalogue"`.

### Changed

- Identifying request fields (`metadata`, which carries Claude Code's account, device and session ids in `metadata.user_id`; `user`; `safety_identifier`; `client_metadata`) are left out of recorded params by default, by every recorder and the Claude Code importer. A field absent from either of two records is not reported as a parameter change. OpenAI's `user` is now classified as cache-relevant (documented as a cache-bucketing key).
- Base64 images, documents, audio and files are written as `"<binary TYPE, N bytes, sha256 …>"` with `"elided": true` on the block. Block hashes are unchanged, so traces written before and after compare equal; a changed image is reported as a changed binary part.
- Trace files and `--html` reports that prefixlens creates are mode 0600, and directories it creates for them 0700; an existing file keeps its mode, with a warning when others can read it.
- The proxy refuses requests with a non-loopback `Host` or with an `Origin` header (403), and warns at start-up about a non-loopback `--host` or a plain-HTTP upstream on another machine.
- The Claude Code importer writes the system block Claude Code sends first but does not log (its billing-attribution line) as an `unknown` block, and the logged `betas` as the `anthropic-beta` header instead of a param. Its blocks and breakpoints now sit where they were sent; traces imported before this change have one system block fewer and are not comparable block for block with new ones. Its digest check is described as what it is: a match with the request Claude Code built, not with the bytes sent.
- `Recorder.begin()` returns a pending call whose `finish` is asynchronous; `lens.observe` is unchanged.
- A cut-off call is recorded with `"interrupted": true` instead of `source.complete: false`; traces with the old marker from prefixlens's own recorders are still read as interrupted.
- An empty `PREFIXLENS_PRICING` no longer leaves the report's pricing note without a source name.
- `package.json` is marked `private` until the first release, so it cannot be published by accident.
- The README's install instructions describe using prefixlens from a clone, since it is not on a registry yet.

### Fixed

- A reported zero cache-write count on OpenAI (the ChatGPT sign-in backend reports one on every call) was read as "nothing was cached", so a real partial miss could show as a hit. Implicit-caching providers (OpenAI, Gemini) now expect the whole previous prompt to be cached whatever write figure they report; a real count can only raise the expectation. Anthropic's zero still means nothing was written.
- The proxy built each record before the client had the end of the response, delaying the last chunk by up to a quarter of a second on long requests. It now hands every byte, the body's end included, to the socket first, canonicalizes each request once, and hashes its blocks one per turn of the event loop so other open streams are not held up.

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
