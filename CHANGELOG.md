# Changelog

All notable changes to prefixlens are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, a minor version may break compatibility).

## [Unreleased]

## [0.7.0] - 2026-11-18

### Added

- **The size of a break in a test.** A failed `assertPrefixStable`, `session.assertStable()` or `assertSessionStable` now has a `size:` line under the first changed block. It says about how many tokens the break re-reads and how many still match. When the model has a price in the pricing table, it also says what the re-read costs above the cache-read price at list prices, for that one call. The token counts are an estimate from the request text, four characters of JSON to a token, the rule the test session already uses for its usage. The explanation carries the numbers as `size` (`reread`, `matching`, `unsized`, `cost`), for allowed breaks too. A new `pricing` option takes your own pricing table, or `false` for tokens only. By default the pricing table bundled with the package is read from disk once, on the first break. Nothing is fetched, and a table that cannot be read means no price, not an error. Messages for a stable pair and for allowed breaks are unchanged. See [docs/assertions.md](https://github.com/parthg1901/prefixlens/blob/main/docs/assertions.md#the-size-of-a-break).
- **Steps in a test session.** `session.step(name)` marks what the test does next ("reload instructions", "compaction"); every call made after it, until the next mark, belongs to that step. Failure messages name it (`prefix not stable at call 15 (step "compaction", lane main, compared with call 14)`), and `explain()` entries and `session.requests` carry `step`. `allowBreakIn: { compaction: "compaction" }` allows a break by step name, so a test no longer changes when its run shifts by a call: it allows one break per step, the first call in the step whose prefix changed. `session.summary()` gives one result per step (stable, break with its one-line summary, allowed, not checked), as data and as a table, and a failing `assertStable` lists every step that breaks after the first failure's full message. A step that records no call fails `assertStable`. `assertSessionStable` takes the same through `steps: { 1: "first question", 12: "compaction" }`. A test with no steps behaves as before.
- **`prefixlens check --requests <file>`** checks request bodies that a project's own tests captured, in any language, with no script and no package.json. The file is a JSON array of bodies or JSON Lines, in the order they were sent. The bodies are checked as `assertSessionStable` checks them, with the same lanes and the same failure message. `--allow-break-at 7=compaction`, `--ignore-params` and `--provider` are its options. A pass prints how many calls were compared. It exits 0 on a pass, 1 on a break, and 2 when the bodies cannot be checked: unreadable input, nothing to compare, or a call that continues a conversation the provider keeps. See [docs/check.md](https://github.com/parthg1901/prefixlens/blob/main/docs/check.md#request-bodies-from-your-own-tests).

### Fixed

- **A break that passed unseen.** A request that changed its tool list and its system prompt at once shares nothing at its start with the conversation's earlier requests, so it opened a lane of its own and was compared with nothing: a test passed with the first tool removed or the tools reordered, wherever the system prompt lists the tools. The lane is still its own, since such a request can read none of the old lane's cache, but its first request is now compared with the latest request of the conversation it carries on, and the change is reported: "prefix not stable at call 14 (lane lane-2, compared with call 13 of lane main, whose conversation it carries on)". What marks a request as that conversation's is a reply it holds, and that it offers tools; a title or a summary written from the messages with no tools, and another agent handed the same first message, are compared with nothing, as before. This applies to test sessions, `assertSessionStable` and `check --requests`; `explain()` entries gain `follows`. Recorded traces and their lanes are unchanged.
- `prefixlens check` exits 2, as documented, for an unknown option or an option given no value. It exited 1.

## [0.6.1] - 2026-11-17

### Fixed

- A request that continues a conversation the provider keeps (Anthropic's `thread`, OpenAI's `previous_response_id` or `conversation`) carries only what is new, and was reported as a cache break: "request parameters changed: thread" in a test session, a changed prefix in `prefixlens check`. Such a call is no longer compared with the one before it. `session.assertStable()`, `assertSessionStable` and `assertPrefixStable` throw an `Error` that names the calls they could not check, so a test does not pass on requests it never compared; `explain` lists them with `notChecked`. In a trace the call is judged by its usage alone, and the report says how many calls that applies to. A recorder keeps such a call in the lane of the reply it names.

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

[Unreleased]: https://github.com/parthg1901/prefixlens/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/parthg1901/prefixlens/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/parthg1901/prefixlens/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/parthg1901/prefixlens/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/parthg1901/prefixlens/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/parthg1901/prefixlens/releases/tag/v0.5.0
