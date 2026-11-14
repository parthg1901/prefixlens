# Changelog

All notable changes to prefixlens are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, a minor version may break compatibility).

## [Unreleased]

## [0.6.0] - 2026-11-14

### Added

- **Test sessions** (`prefixlens/test`). `recordRequests()` returns a session whose `fetch` takes the model provider's place in a test of a framework or an agent loop: it records every Anthropic Messages, OpenAI Chat Completions and OpenAI Responses request, answers it in that format with no network (as a stream when the request asks for one), and `session.assertStable()` asserts that every request keeps the prefix of the one before it in its conversation. Side calls such as a title generator's get a lane of their own. `reply` scripts the model's answers, text or tool calls; `callTools` is the script for a tool loop. `allowBreakAt` allows a break at one call, e.g. `{ 7: "compaction" }`. `session.explain()`, `session.requests` and `session.writeTrace(file)` give the comparisons, the request bodies and a trace file. `assertSessionStable(bodies)` does the same for request bodies you already have.
- **`prefixlens check <trace>`**, a CI gate. It exits 1 when a call lost cached tokens for a reason the harness controls or changed its prefix without declaring it, and prints those calls with their cause, the changed block and the fix; 0 otherwise; 2 when the trace cannot be checked. Expiry, provider-side misses, cold and warm starts, declared breaks and unexplained usage-only misses pass unless named in `--fail-on`. `--allow <causes>` marks causes as intentional for a trace that cannot declare breaks, and `--json` prints the verdict for every call. `classifyMisses(analysis)` returns the same result from code. See [docs/check.md](https://github.com/parthg1901/prefixlens/blob/main/docs/check.md).
- The JSON report names the changed block of a cause (`block_label`) and says why a prefix change that cost nothing is not held against the harness (`prefix_change_excused`).
- An example project with a session test for each request format, [`examples/framework-session-test`](https://github.com/parthg1901/prefixlens/tree/main/examples/framework-session-test).

### Fixed

- A side query that repeats the first message of a conversation with no tools, such as a title written from it, no longer joins that conversation's lane, where it was reported as a changed system prompt.

## [0.5.1] - 2026-11-12

### Changed

- Releases are published from GitHub Actions through npm trusted publishing, with a provenance statement that links each version to the commit and workflow run that built it. The package contents are the same as 0.5.0.

## [0.5.0] - 2026-11-12

First public release.

### Added

- **Test assertions** (`prefixlens/test`). `assertPrefixStable(prev, next)` fails a test when the second of two requests your harness builds does not keep the first one's prefix. `explainPrefixDiff` returns the same explanation without throwing. A failure names the first changed block, shows a diff and suggests a fix. Options: `allowBreak`, `ignoreParams`, `hints`, `provider`. Pure functions, no network.
- **Recording proxy** (`prefixlens record`). A local proxy for any client whose base URL can be set. It forwards each request with its body and credentials unchanged, streams the response back, and appends one full-request record per model call. It assigns each call to a lane by shared prefix, so concurrent conversations and subagents are compared with their own previous call.
- **Recording library.** `wrap(client)` for the official Anthropic and OpenAI TypeScript SDKs, `createLens().fetch()` for any client that takes a fetch function, `lens.observe()` for custom clients, `buildRecord()` to build the same record from a request and a response, and `startProxy()`.
- **Request formats.** Anthropic Messages, OpenAI Chat Completions and OpenAI Responses, streamed or not. The assertions also read Gemini `generateContent` bodies.
- **Reports** (`prefixlens report`). For each call: tokens read from the cache, written and uncached, the hit rate and the cost. For each miss: the first changed block, a diff, the tokens lost and the cost. Output as a terminal table, JSON (`--json`) or one self-contained HTML file (`--html`).
- **Causes.** Tool-list and tool-order changes, system-prompt edits and re-rendered timestamps, ids and relative dates, history rewrites (edited, inserted, removed or reordered messages, rewritten tool output or reasoning, a sliding window, a rewind), merged or split steps, compaction, model and parameter changes, cache expiry and provider-side misses. Each is labelled confirmed, inferred or unknown.
- **Caching rules.** Explicit breakpoints (Anthropic `cache_control`, OpenAI `prompt_cache_breakpoint`) and implicit caches (OpenAI, Gemini), with the cache step learnt from the trace. A table per provider says which request parameters are part of the cached prefix, each entry marked verified, documented or assumed.
- **Intentional breaks.** A harness declares a compaction, revert, refusal, model switch or settings change with a `prefix_break` hint, or `allowBreak` in a test. A declared break is reported with its cost, totalled apart from other misses.
- **Trace format 1.3** ([SPEC.md](SPEC.md)). JSON Lines, one record per model call, with ordered and hashed request blocks, usage and a fidelity flag. Specified with hash test vectors, so a harness in any language can write it.
- **Pricing.** List prices for Anthropic, OpenAI and Gemini models in `pricing.json`, with sources, cache-write lifetimes, prompt-size tiers and dated prices. `--pricing` and `PREFIXLENS_PRICING` use another table. `prefixlens pricing update`, `check` and `show` add an optional second source, the models.dev catalogue, fetched only on request.
- **Importers** (`prefixlens import`). For logs you already have: OpenTelemetry GenAI spans (`otel`), and the session logs of Claude Code (`claude-code`), Codex (`codex`) and opencode (`opencode`). `prefixlens adapters` lists what each can diagnose.
- **Privacy defaults.** Credentials and all but four request headers are never written. Identifying request fields and the bytes of images and documents are left out unless asked for. Trace and report files are created readable by their owner only. Control characters in trace content are written visibly on the terminal. No telemetry. See [SECURITY.md](SECURITY.md).
- **Runtimes.** Node.js 22 or later and Bun, with type declarations and no runtime dependencies.

[Unreleased]: https://github.com/parthg1901/prefixlens/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/parthg1901/prefixlens/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/parthg1901/prefixlens/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/parthg1901/prefixlens/releases/tag/v0.5.0
