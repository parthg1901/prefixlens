// A local stand-in for the Anthropic and OpenAI APIs, serving the hand-written
// stream fixtures in test/fixtures/streams one event per chunk.

import path from "node:path"

const streams = path.join(import.meta.dir, "fixtures", "streams")

export const STREAM_FILES = {
  "/v1/messages": "anthropic.sse",
  "/v1/chat/completions": "chat.sse",
  "/v1/responses": "responses.sse",
} as const

const JSON_BODIES: Record<string, unknown> = {
  "/v1/messages": {
    id: "msg_synthetic_json",
    type: "message",
    role: "assistant",
    model: "claude-test-1",
    content: [{ type: "text", text: "Synthetic answer." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000, output_tokens: 4 },
  },
  "/v1/chat/completions": {
    id: "chatcmpl-synthetic-json",
    object: "chat.completion",
    created: 1767261600,
    model: "gpt-test-1",
    choices: [{ index: 0, message: { role: "assistant", content: "Synthetic answer.", refusal: null }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 1500, completion_tokens: 4, total_tokens: 1504, prompt_tokens_details: { cached_tokens: 1280 } },
  },
  "/v1/responses": {
    id: "resp_synthetic_json",
    object: "response",
    created_at: 1767261600,
    status: "completed",
    model: "gpt-test-1",
    output: [{ id: "msg_synthetic_03", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Synthetic answer.", annotations: [] }] }],
    usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1792 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2006 },
  },
}

export interface SeenRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

export async function streamText(file: keyof typeof STREAM_FILES) {
  return Bun.file(path.join(streams, STREAM_FILES[file])).text()
}

/**
 * Starts the fake API. A request with `x-test-hold: 1` gets its first event,
 * then waits for `release()` before the rest, so a test can prove the proxy
 * passes bytes on before the upstream has finished.
 */
export function startFakeUpstream(options: { delayMs?: number } = {}) {
  const seen: SeenRequest[] = []
  let release = () => {}
  let held = new Promise<void>((resolve) => (release = resolve))
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const bytes = new Uint8Array(await request.arrayBuffer())
      const body = Buffer.from(request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes).toString("utf8")
      seen.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers), body })
      const file = STREAM_FILES[url.pathname as keyof typeof STREAM_FILES]
      if (!file) return Response.json({ error: { type: "not_found_error", message: "synthetic 404" } }, { status: 404 })
      if (request.headers.get("x-test-status")) return Response.json({ error: { type: "overloaded_error", message: "synthetic" } }, { status: Number(request.headers.get("x-test-status")) })
      const parsed = JSON.parse(body) as { stream?: boolean }
      if (!parsed.stream) return Response.json(JSON_BODIES[url.pathname], { headers: { "request-id": "req_synthetic" } })
      const events = (await Bun.file(path.join(streams, file)).text()).split(/(?<=\n\n)/)
      const hold = request.headers.get("x-test-hold") === "1"
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const [index, event] of events.entries()) {
            if (request.signal.aborted) return
            controller.enqueue(encoder.encode(event))
            if (hold && index === 0) await held
            else await Bun.sleep(options.delayMs ?? 2)
          }
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "request-id": "req_synthetic" } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    release() {
      release()
      held = new Promise<void>((resolve) => (release = resolve))
    },
    stop: () => server.stop(true),
  }
}
