// Block hashes are the identity of a request's parts: a trace written by one
// version must compare equal with one written by the next. These hashes were
// computed before any change that could touch them and must never change.

import { describe, expect, test } from "bun:test"
import { canonicalizeAnthropic, hashContent } from "../src/canonical.ts"
import { buildRecord } from "../src/index.ts"
import type { TraceRecord } from "../src/trace.ts"

// Synthetic bytes, large enough to count as a binary part wherever a size threshold applies.
const BINARY = Buffer.from("synthetic image bytes ".repeat(100)).toString("base64")

const hashes = (record: TraceRecord | string) => {
  if (typeof record === "string") throw new Error(record)
  return record.request!.blocks.map((block) => [block.kind, block.hash, block.breakpoint ?? false])
}

describe("pinned block hashes", () => {
  test("SPEC.md test vectors", () => {
    expect(hashContent({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862")
    expect(hashContent({ type: "custom", name: "read_file" })).toBe("5d364be90495295000470579a9553503093c9e3b7d035f94f0626e24de3693e1")
    expect(hashContent({ role: "user", content: [{ type: "text", text: "hi" }] })).toBe("da3ac0b4d79dbe28c3c6684e1e4d037992df0e519e410c56436a23ecadf5c3c1")
  })

  test("the SPEC.md example's blocks, from the request bodies", () => {
    const blocks = canonicalizeAnthropic({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      tools: [
        { name: "read_file", description: "Read a file.", input_schema: { type: "object" } },
        { name: "web_fetch", description: "Fetch a URL.", input_schema: { type: "object" } },
      ],
      system: "You are a coding agent.",
      messages: [
        { role: "user", content: "Fix the bug." },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.py" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "print(1)" }] },
        { role: "assistant", content: "Fixed." },
        { role: "user", content: "Thanks." },
      ],
    }).blocks.map((block) => block.hash)
    expect(blocks).toEqual([
      "30e0dcd015ebdc47cd26068d185bf8c2fa77fa79248383ceabec55c715551030",
      "d19924e6b34eb7bd1fdb88375d0fb37824280385b21a9b7119e6a6c99ff08c87",
      "fee3c7ab8de0808c86ac65af7fb2c71887f6b55eda5c4e8794a58a4c1f0e9822",
      "913f6ca8015045bfd57dd7baa26a020b5b82096e3fe980fbda697495d4507585",
      "2359ae584ca07720bc4364a8f6130313f9c48622a57e957db74867071e87157e",
      "fd50c03bc418abdadc0b0e89fb640e4bf86d01f1eb465d2041903911afd053ef",
      "d0358957456d5970f9f8b9c2a82404c0b9dd6b2381b9941dac19d6b706fe40cc",
      "8ce9c6a2aaf41c70bb9a882db326a43a050ec7274e358130c2e13a6660f2aa0d",
    ])
  })

  test("an Anthropic request with identifiers, an image, a document and breakpoints", () => {
    const record = buildRecord({
      api: "anthropic-messages",
      body: {
        model: "claude-test-1",
        max_tokens: 100,
        stream: true,
        metadata: { user_id: "synthetic-user" },
        tools: [{ name: "read_file", description: "Read a file.", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: BINARY } }, { type: "text", text: "What is this?" }] },
          { role: "assistant", content: "A test." },
          {
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: BINARY } },
              { type: "text", text: "And this?", cache_control: { type: "ephemeral" } },
            ],
          },
        ],
      },
      response: { usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 5 }, complete: true },
      startedAt: 0,
    })
    expect(hashes(record)).toEqual([
      ["tool", "30e0dcd015ebdc47cd26068d185bf8c2fa77fa79248383ceabec55c715551030", true],
      ["system", "fee3c7ab8de0808c86ac65af7fb2c71887f6b55eda5c4e8794a58a4c1f0e9822", true],
      ["message", "e9770c3cad4f06a7c81e2c1ff8c62b3a44866adcc29c677ec56cfe5fe9bafb21", false],
      ["message", "22252e53684b009e2051eb3762034947ff33a9c3a55db1013114cd5cfaf95690", false],
      ["message", "342d6f54c88cbef4bce229474cd8afbca25b052f65d8cd296d21880fb23f60ee", true],
    ])
  })

  test("an OpenAI Responses request with identifiers and an image", () => {
    const record = buildRecord({
      api: "openai-responses",
      body: {
        model: "gpt-test-1",
        stream: true,
        user: "u-1",
        safety_identifier: "s-1",
        prompt_cache_key: "k-1",
        instructions: "Be brief.",
        tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${BINARY}` }, { type: "input_text", text: "Describe." }] }],
      },
      response: { usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 }, complete: true },
      startedAt: 0,
    })
    expect(hashes(record)).toEqual([
      ["tool", "c23fee5f46cbee5161ac1c894c898583e90438db47d54804687c45fad18acd89", false],
      ["system", "d52241f53eaa1aab2a8681d6d2825b7bafa2d4acdcc4f9d4bfd3130c493ba565", false],
      ["message", "6fcada6acfba2aff8f21560988068dcc9abb3a87bdb2d27132895906ace4ae3b", false],
    ])
  })

  test("an OpenAI Chat Completions request with a user id and an image", () => {
    const record = buildRecord({
      api: "openai-chat",
      body: {
        model: "gpt-test-1",
        user: "u-2",
        messages: [
          { role: "system", content: "Sys." },
          { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${BINARY}` } }, { type: "text", text: "Hi" }] },
        ],
      },
      response: { usage: { prompt_tokens: 2000, completion_tokens: 1 }, complete: true },
      startedAt: 0,
    })
    expect(hashes(record)).toEqual([
      ["system", "74a617a92811620ccd5542c86121c003dffc274dbc2747d06e9858f70885ee64", false],
      ["message", "89574c69a7b79295030decf40f3dabe669de955a503fab60e288f02c5d214a25", false],
    ])
  })
})
