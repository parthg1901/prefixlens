# The recording proxy

`prefixlens record` runs a local proxy that records every model call a client sends through it. It works with any client whose base URL can be set: your own harness, an SDK, a framework, or a tool built on one.

```sh
prefixlens record --provider anthropic -o run.trace.jsonl     # listens on 127.0.0.1:8787
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787               # in another terminal, then run your agent as usual
# Ctrl-C the proxy, then
prefixlens report run.trace.jsonl
```

While it runs, the proxy prints one line per call, so you can watch the hit rate while you work:

```
#2 main gpt-6-luna: prompt 2,987, cache read 2,816 (94%), output 9
```

## Options

| option | meaning |
|---|---|
| `--provider anthropic\|openai` | Which API (required). Sets the default upstream. |
| `--port <n>` | Port (default 8787). |
| `--host <address>` | Listen address (default 127.0.0.1). |
| `-o, --out <file>` | Trace to append to (default `prefixlens.trace.jsonl`). |
| `--upstream <url>` | Forward somewhere else: a gateway, a regional endpoint. |
| `--allow-origin <origins>` | Do not refuse requests whose `Origin` is one of these (comma-separated, or `*`). |
| `--keep-identifiers` | Keep `metadata`, `user`, `safety_identifier` and `client_metadata` in the recorded params. |
| `--keep-binary` | Keep base64 images, documents and audio in the trace instead of their SHA-256 and size. |
| `--quiet` | No line per call. |

Notes on two of them:

- **`--upstream`.** A path in the URL is prefixed to each request path. With `https://chatgpt.com` (the backend of ChatGPT sign-in), records are marked `"billing": "subscription"`.
- **`--allow-origin`.** By default a request with an `Origin` header is refused with 403. Allowing an origin does not by itself make the proxy usable from a web page. The proxy adds no CORS response headers and forwards the preflight upstream, so a page can read the answer only if the upstream's CORS headers allow it.

`startProxy(options)` starts the same proxy from code; see [library.md](library.md#startproxy).

## The base URL to set

The rule is the same for every client: start the proxy for the API the client speaks, and set the client's base URL to the proxy.

| client | start the proxy with | then set |
|---|---|---|
| Any Anthropic-compatible client | `--provider anthropic` | its base URL to `http://127.0.0.1:8787` |
| Any OpenAI-compatible client | `--provider openai` | its base URL to `http://127.0.0.1:8787/v1` |
| A client of a gateway or another compatible endpoint | `--provider openai` (or `anthropic`) and `--upstream https://gateway.example` | its base URL to `http://127.0.0.1:8787` followed by the path of the endpoint's base URL, e.g. `/v1` |

Examples:

| client | start the proxy with | then set |
|---|---|---|
| Anthropic SDKs (TypeScript, Python) | `--provider anthropic` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |
| OpenAI SDKs (TypeScript, Python), and tools built on them | `--provider openai` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| Claude Code | `--provider anthropic` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |
| Codex CLI with an API key | `--provider openai` | `openai_base_url="http://127.0.0.1:8787/v1"` |
| Codex CLI with ChatGPT sign-in | `--provider openai --upstream https://chatgpt.com` | `openai_base_url="http://127.0.0.1:8787/backend-api/codex"` |
| A Responses API client with ChatGPT sign-in | `--provider openai` | its base URL option: `http://127.0.0.1:8787/v1` |
| opencode, with its `opencode/*` models | `--provider openai --upstream https://opencode.ai/inference/openai` | `baseURL` of the `opencode` provider: `http://127.0.0.1:8787/v1` |

Details for those rows:

- **Codex CLI.** Pass the setting on the command line (`codex -c 'openai_base_url="..."'`) or put `openai_base_url` in `~/.codex/config.toml`. With ChatGPT sign-in, Codex sends its requests to `https://chatgpt.com/backend-api/codex/responses`, and a base URL ending in `/backend-api/codex` keeps the routes Codex uses only on its own backend.
- **WebSockets.** Codex opens Responses over a WebSocket first. The proxy answers the handshake with 426, and Codex switches to HTTP at once.
- **opencode.** The setting goes in `~/.config/opencode/opencode.json`: `"provider": { "opencode": { "options": { "baseURL": "http://127.0.0.1:8787/v1" } } }`. For another provider, use that provider's id and start the proxy for the API it speaks.

## What the proxy forwards

The proxy forwards every request to the upstream with its method, path, query, body and credentials as the client sent them, and streams each response back chunk by chunk as it arrives. It does not change the content of a request or a response.

It is not a byte-for-byte relay:

- it drops the hop-by-hop headers and its own two (`x-prefixlens-lane`, `x-prefixlens-session`), and narrows `accept-encoding` to what the runtime can decode;
- the runtime's fetch adds its defaults for headers the client did not send (`accept`, `accept-encoding`, `user-agent`; on Node also `accept-language` and `sec-fetch-mode`);
- it reads each request body whole before forwarding it;
- it passes the response on decompressed, without the provider's `content-encoding` and `content-length`.

The exact list is in [SECURITY.md](../SECURITY.md#the-recording-proxy).

## What is recorded

When a model call ends, and only after the client has received every byte of the response, the proxy appends one full-request record: the canonical request, the final usage and the request start time.

- **Recorded.** `POST …/messages` (Anthropic Messages), `…/chat/completions` and `…/responses` (OpenAI), streamed or not. Streams are SSE, with or without `[DONE]`, with `: keep-alive` comments. Compressed request bodies (gzip, deflate, br, zstd) are decoded.
- **Passed through.** Everything else passes through unrecorded, as do error responses.
- **WebSockets.** Handshakes are answered `426 Upgrade Required` and never forwarded: the proxy relays HTTP only.
- **Cut-off calls.** A client that disconnects mid-stream is recorded only if the stream already reported usage (Anthropic does in its first event). The record is marked `"interrupted": true`, and the report shows the call as cut off, with its output and cost as lower bounds.
- **Usage in streams.** Chat Completions streams report usage only with `stream_options: {"include_usage": true}`. The proxy never changes a request body, so it does not add it; without it those calls are skipped with a note.
- **zstd on Node.** Decoding zstd-compressed request bodies needs Node 22.15 or later. Bun decodes them.

Never written:

- auth headers, cookies and API keys;
- every other request header except `session-id` (cache affinity on OpenAI's ChatGPT sign-in flow), `anthropic-beta`, `anthropic-version` and `openai-beta`;
- identifying request fields and the bytes of images and documents, unless `--keep-identifiers` or `--keep-binary` is given.

See [SECURITY.md](../SECURITY.md) for the full account.

## What is refused

A request is refused with 403, and not forwarded, when:

- its `Host` is not a loopback name or the `--host` address; or
- it carries an `Origin` header that `--allow-origin` does not allow.

Browsers send `Origin` on the requests a page can make to an API (a cross-origin `fetch` or `POST`), and command-line clients do not. This keeps a web page open in your browser from sending model calls through the proxy.

A plain `GET` navigation or image load carries no `Origin`. It is forwarded, unrecorded and without credentials.

## Lanes

One proxy often carries several conversations at once (subagents, title generation, side queries), and each call must be compared with the call it builds on. The proxy assigns lanes by shared prefix. A call joins the first of these that applies:

1. the lane whose latest request it extends;
2. else the lane it shares the most leading messages with, when it also shares the start of the request, or that lane is idle with the same tools or system prompt (an edit, a mode switch);
3. else an idle lane with the same tools and system prompt (a compaction);
4. else it opens a new lane.

A call that does not extend a lane joins it only when its cache key (the `session-id` header, else `prompt_cache_key`) matches. A harness that names its conversations this way gets a lane per conversation.

## Sessions

- **Explicit lanes and sessions.** A harness that knows which conversation a call belongs to can send `x-prefixlens-lane` and `x-prefixlens-session`. They win over everything else. The proxy strips both before forwarding.
- **Session headers.** The proxy also reads the session headers listed in `SESSION_HEADERS`: `x-opencode-session-id`, and `x-opencode-parent-session-id` from a subagent. These headers are forwarded and not written.
- **Sessions and subagents.** With those headers, each call is recorded in its session, and a subagent's calls in its root session as lane `subagent:<id>`. Two sessions run one after the other through one proxy never share a lane.
- **Title calls.** With those session headers, a title call that comes first in a new session, with its own instructions, opens the session's `main` lane, and the conversation itself is `lane-2`.
- **Restarts.** A proxy started on a trace that already has records (`-o` with an existing file) reads the lanes the file holds and continues them. A conversation carried over a restart is compared with its own previous call, and new conversations get lane names the file does not use yet.
