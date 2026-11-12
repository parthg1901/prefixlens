# Security and privacy

prefixlens sits between an agent harness and its model provider, or inside the harness's own process, and writes what it sees to a trace file. This page says exactly what it sees, what it writes, and what it never writes. Each statement about what is written or stripped is checked by a test in `test/privacy.test.ts` or `test/record.test.ts`.

## Reporting a vulnerability

Please report security problems privately: open a private security advisory on the project's repository (on GitHub: the repository's **Security** tab, then **Report a vulnerability**). Do not open a public issue for a vulnerability. Include the version (`prefixlens --version`), what you ran, and what was exposed.

prefixlens has not had a first release yet; until it does, only the latest commit is supported.

## Traces contain your prompts and code

**Treat every trace as sensitive, and never commit one.** A trace records the full request of every model call, as sent: the system prompt, every tool definition, and every message in the conversation, including your prompts, the files and code the agent read, tool outputs (shell output, search results, anything a tool returned), and earlier assistant replies, which the harness sends back as history. Images and documents sent as base64 are written too. Request parameters are written as sent; that includes identifiers some harnesses put in the body, such as Anthropic's `metadata.user_id` and OpenAI's `user`, `safety_identifier` and `prompt_cache_key`.

The same applies to traces made by `prefixlens import`, which copy the content of the harness's own session logs, and to `--html` and `--json` reports, which include the changed blocks of each miss.

The repository's `.gitignore` ignores `*.trace.jsonl`, `*.trace.html` and `*.report.html`, and CI fails if a trace, session log or credential is committed. Neither helps if you write a trace under another name.

Trace files are created with your default file permissions (your umask), like any other file you create; they are not made private to your user automatically.

## What is never written

From the request headers, only these four are written, under the record's `headers` field: `session-id`, `anthropic-beta`, `anthropic-version` and `openai-beta` (`RECORDED_HEADERS` in `src/record/exchange.ts`). They route a request to a cache or change what is cached. Every other header is dropped before the record is built, including `authorization`, `x-api-key`, `proxy-authorization`, `cookie`, `openai-organization`, `openai-project`, `chatgpt-account-id`, `user-agent` and any custom header. This holds for the proxy, `wrap`, `lens.fetch`, `lens.observe` and `buildRecord`, which all build records with the same function.

From the response, only the usage counts, the response id and the model name are written. The response's content (the model's reply, tool calls, reasoning) is not. It reaches the trace only when the harness sends it back as history in a later request.

Nothing is written for calls that are not model calls (anything other than `POST …/messages`, `…/chat/completions` and `…/responses`), for error responses, or for requests that fail to reach the provider.

## The recording proxy

`prefixlens record` forwards every request to the provider, credentials included and unchanged, and streams the response back. It sees everything the harness sends and receives, API keys included. It removes only hop-by-hop headers (`host`, `connection`, `keep-alive`, `content-length`, `transfer-encoding`) and its own `x-prefixlens-lane` and `x-prefixlens-session` before forwarding.

It listens on `127.0.0.1:8787` by default, so only processes on the same machine can reach it. It has no authentication of its own: any local process can send requests through it, and those requests are written to your trace.

`--host` binds it to another address. Do this only on a network you trust, and understand what it means:

- the harness talks to the proxy over plain HTTP, so API keys and request content cross the network unencrypted;
- anyone who can reach the port can send requests through it to the provider (with their own credentials; the proxy adds none), and their requests are written to your trace.

`--upstream` sends requests, credentials included, wherever you point it. An `http://` upstream receives them unencrypted.

## wrap, lens.fetch and lens.observe

`wrap(client)` and `lens.fetch()` run inside your process. They send each request exactly as the client built it, through the client's own fetch, and record a copy as the response streams back; they make no other request. `lens.observe` and `buildRecord` make no network request at all: they build a record from the request and response you pass in. All of them write the same record as the proxy, with the same headers dropped. `wrap` and `lens.fetch` write to `$PREFIXLENS_TRACE`, else `prefixlens.trace.jsonl` in the working directory, unless you pass `trace` (a path, or `false` to write no file).

## No telemetry

prefixlens sends nothing anywhere on its own. The only outgoing network requests in its source are the proxy forwarding each request to the configured upstream, `wrap`/`lens.fetch` passing requests to the fetch you gave them, and the price fetch below. Importers read local files (the opencode database is opened read-only), reports are written locally, and the HTML report is self-contained and makes no external requests. The pricing table is read from a local file.

`prefixlens pricing update` and `prefixlens pricing check` fetch the models.dev price catalogue, and only when you run one of them without `--from`. Each makes one HTTP GET to `https://models.dev/api.json` and to no other URL: it does not follow redirects. The request has no body, cookies or credentials and carries nothing about your traces; its headers are `host`, `accept: application/json`, `accept-encoding`, `connection` and Bun's default `user-agent` (`Bun/<version>`), as checked in `test/catalogue.test.ts`. The response is read as data (prices, ids and dates; ids with control characters are dropped), limited to 32 MB and 30 seconds. `update` writes only the converted prices to your user cache directory (see Pricing in the README). `report` and `pricing show` read that file if it exists and never fetch.
