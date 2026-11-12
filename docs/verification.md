# Verification

As of 0.5.0. Every feature is covered by tests on small synthetic fixtures. This page lists what has also been checked on real traffic, and what has not.

The checks on real traffic were made on Linux arm64, with Bun 1.4.0 and Node 24.20.

## Checked on real traffic

- **The recording proxy, on all three request formats.** In each case every call was recorded and no credential was in the trace.
  - Anthropic Messages: Claude Code 2.1.322, ten model calls.
  - OpenAI Responses with ChatGPT sign-in: Codex CLI 0.167.0 and one other client. Calls and token counts equal the client's own logs.
  - OpenAI Chat Completions through a gateway: opencode 1.19.5 on its free models. Calls and token counts equal the client's database, plus the title calls it does not store. The gateway reads its cache in steps of 1,088 tokens.
- **Verdicts on request bodies a framework builds.** Mastra (`@mastra/core` 1.82.0, `@mastra/memory` 1.41.0) with a recording stand-in provider: real request bodies, no real provider cache. A sliding history window is reported as "oldest messages removed from the start of history".
- **The importers, against proxy records of the same sessions.**
  - `claude-code`: usage, tool hashes and message hashes are identical on every call, and every rebuilt request matches the digest in the log. Session files of 7 to 102 MB import.
  - `codex`: the records match the proxy's calls one for one, by response id and token counts, and add up to the totals in the log. Its timestamps are 2 to 7 seconds after the request starts.
  - `opencode`: calls and tokens match an independent recount and the proxy. Its timestamps are 30 to 100 ms before the request, and 1 to 3 seconds on a prompt's first call.

## Not checked on real traffic

- `wrap(client)` and `lens.fetch()` against the real APIs. They run against a local stand-in for each API.
- The SDK rows of the base-URL table in [proxy.md](proxy.md): the TypeScript SDKs run against a local stand-in, and the Python SDK rows and the Codex API-key row follow those clients' documented settings.
- Recording from inside a framework. `lens.fetch()` and the proxy are not run with the Vercel AI SDK or Mastra.
- Most verdict rules. Of the rules that came from real requests (warm starts, learnt cache steps, expiry ahead of a prefix change, compaction that keeps a tail, inserted parts, relative dates, the sliding window), only the sliding window has been run on those requests in its current form.
- Cache expiry on real Anthropic traffic.
- The proxy's lane assignment for an interactive session with side calls on Anthropic Messages.
- OpenAI's explicit cache breakpoints (`prompt_cache_breakpoint`), implemented from OpenAI's documentation and SDK types.
- The `otel` importer.
- The `opencode` importer on a provider that caches and is priced, and on compactions.
- The prices in `pricing.json`, against a second source.
- Real traffic on macOS, on other Node versions, or on Bun before 1.4.0.
- The release workflow's publish step. 0.5.0 is published by hand.
