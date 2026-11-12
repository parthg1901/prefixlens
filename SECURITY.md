# Security and privacy

prefixlens sits between an agent harness and its model provider, or inside the harness's own process, and writes what it sees to a trace file. This page says exactly what it sees, what it writes, and what it never writes. Each statement about what is written, stripped or refused is checked by a test in `test/privacy.test.ts`, `test/record.test.ts`, `test/proxy-guard.test.ts`, `test/binary.test.ts` or `test/cli-private.test.ts`.

## Reporting a vulnerability

Please report security problems privately: open a private security advisory on the project's repository (on GitHub: the repository's **Security** tab, then **Report a vulnerability**). Do not open a public issue for a vulnerability. Include the version (`prefixlens --version`), what you ran, and what was exposed.

prefixlens has not had a first release yet; until it does, only the latest commit is supported.

## Traces contain your prompts and code

**Treat every trace like source code plus personal data: keep it private, and never commit one.** By design, a trace records the full request of every model call, as sent: the full system prompt, every tool definition, the instruction files and memory the harness sends with it (`CLAUDE.md`, `AGENTS.md`, memory files), and every message in the conversation, including your prompts, the contents of files the agent read, tool outputs (shell output, search results, anything a tool returned), and earlier assistant replies, which the harness sends back as history. That usually includes working-directory paths, and often your email address, which harnesses put in their system prompts and git context.

Left out by default:

- request fields that identify a person, account, device or installation and are not model input: `metadata` (Anthropic's `metadata.user_id`, where Claude Code puts its account id, a persistent device id and the session id; OpenAI's developer key-value pairs), `user`, `safety_identifier`, and Codex's `client_metadata` (`IDENTIFYING_PARAMS` in `src/params.ts`). The importers drop the same fields. `keepIdentifiers` (`--keep-identifiers`) keeps them. Leaving them out changes no block hash; OpenAI documents `user` as a cache-bucketing key, so without it a miss caused by changing `user` reads as one with the prefix intact;
- the bytes of base64 images, documents, audio and files, which are written as their SHA-256 and decoded size (SPEC.md section 4.5). Block hashes are still those of the request as sent. `keepBinary` (`--keep-binary`) keeps the bytes.

Kept, because the analysis needs them: `prompt_cache_key` and the `session-id` header, which providers route requests to a cache by. A harness may derive them from a session or user id.

The same applies to traces made by `prefixlens import`, which copy the content of the harness's own session logs, and to `--html` and `--json` reports, which include the changed blocks of each miss.

The repository's `.gitignore` ignores `*.trace.jsonl`, `*.trace.html` and `*.report.html`, and CI fails if a trace, session log or credential is committed. Neither helps if you write a trace under another name.

Trace files prefixlens creates (the proxy, `wrap`, `lens.fetch`, `lens.observe` with a trace path, `prefixlens import -o`) and `report --html` reports are created readable and writable by their owner only (mode 0600), and directories it creates for them owner-only (0700). A file or directory that already exists keeps its permissions: prefixlens never changes a mode you set. The proxy and `import -o` print a warning when such a file is readable by other users. A report printed to stdout (`--json`, the terminal report) or a trace written to stdout by `import` gets whatever permissions you redirect it into.

## What is never written

From the request headers, only these four are written, under the record's `headers` field: `session-id`, `anthropic-beta`, `anthropic-version` and `openai-beta` (`RECORDED_HEADERS` in `src/record/exchange.ts`). They route a request to a cache or change what is cached. Every other header is dropped before the record is built, including `authorization`, `x-api-key`, `proxy-authorization`, `cookie`, `openai-organization`, `openai-project`, `chatgpt-account-id`, `user-agent` and any custom header. This holds for the proxy, `wrap`, `lens.fetch`, `lens.observe` and `buildRecord`, which all build records with the same function.

From the response, only the usage counts, the response id and the model name are written. The response's content (the model's reply, tool calls, reasoning) is not. It reaches the trace only when the harness sends it back as history in a later request.

Nothing is written for calls that are not model calls (anything other than `POST …/messages`, `…/chat/completions` and `…/responses`), for error responses, or for requests that fail to reach the provider.

## The recording proxy

`prefixlens record` forwards every request to the provider, credentials included and unchanged, and streams the response back. It sees everything the harness sends and receives, API keys included. It removes only hop-by-hop headers (`host`, `connection`, `keep-alive`, `content-length`, `transfer-encoding`) and its own `x-prefixlens-lane` and `x-prefixlens-session` before forwarding.

It listens on `127.0.0.1:8787` by default, so only processes on the same machine can reach it. It has no authentication of its own: any local process can send requests through it (with its own credentials; the proxy adds none), and those requests are written to your trace.

A web page in your browser can also send requests to a loopback port. The proxy refuses, with 403 and without forwarding:

- a request whose `Host` header is not a loopback name (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) or the address given with `--host`, which defeats DNS rebinding;
- a request with an `Origin` header, which browsers send on cross-origin requests and harness CLIs do not, unless `--allow-origin` (`allowedOrigins`) names that origin.

This does not make the proxy safe to expose: it does not authenticate the client, and a local process is trusted.

`--host` binds it to another address. Do this only on a network you trust, and understand what it means:

- the harness talks to the proxy over plain HTTP, so API keys and request content cross the network unencrypted;
- anyone who can reach the port can send requests through it to the provider (with their own credentials; the proxy adds none), and their requests are written to your trace.

`--upstream` sends requests, credentials included, wherever you point it. An `http://` upstream receives them unencrypted.

The proxy prints a warning at start-up when `--host` is not a loopback address and when `--upstream` is plain HTTP to another machine.

## wrap, lens.fetch and lens.observe

`wrap(client)` and `lens.fetch()` run inside your process. They send each request exactly as the client built it, through the client's own fetch, and record a copy as the response streams back; they make no other request. `lens.observe` and `buildRecord` make no network request at all: they build a record from the request and response you pass in. All of them write the same record as the proxy, with the same headers and identifying fields dropped and binary data elided. `wrap` and `lens.fetch` write to `$PREFIXLENS_TRACE`, else `prefixlens.trace.jsonl` in the working directory, unless you pass `trace` (a path, or `false` to write no file).

## No telemetry

prefixlens sends nothing anywhere on its own. The only outgoing network requests in its source are the proxy forwarding each request to the configured upstream, `wrap`/`lens.fetch` passing requests to the fetch you gave them, and the price fetch below. Importers read local files (the opencode database is opened read-only), reports are written locally, and the HTML report is self-contained and makes no external requests. The pricing table is read from a local file.

`prefixlens pricing update` and `prefixlens pricing check` fetch the models.dev price catalogue, and only when you run one of them without `--from`. Each makes one HTTP GET to `https://models.dev/api.json` and to no other URL: it does not follow redirects. The request has no body, cookies or credentials and carries nothing about your traces; its headers are `host`, `accept: application/json`, `accept-encoding`, `connection` and the runtime's default `user-agent` (`Bun/<version>` on Bun, as checked in `test/catalogue.test.ts`; `node` on Node, whose fetch also adds `accept-language: *` and `sec-fetch-mode: cors`). The response is read as data (prices, ids and dates; ids with control characters are dropped), limited to 32 MB and 30 seconds. `update` writes only the converted prices to your user cache directory (see Pricing in the README). The data is public, but the file is created owner-only (0600) like every file prefixlens creates, in a directory created owner-only (0700) if it did not exist; each update replaces the file, mode included. `report` and `pricing show` read that file if it exists and never fetch.
