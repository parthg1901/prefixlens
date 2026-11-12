// Base64 images, documents, audio and files are written as their SHA-256 and
// size, not their bytes. Block hashes stay those of the request as sent, so a
// trace written either way compares equal, and a changed image still shows.

import { describe, expect, test } from "bun:test"
import { analyze } from "../src/analyze.ts"
import { elideBinary, makeBlock } from "../src/canonical.ts"
import { comparePrefix } from "../src/diff.ts"
import { parsePricing } from "../src/pricing.ts"
import { buildRecord } from "../src/record/exchange.ts"
import { parseTrace, serializeTrace, type TraceRecord } from "../src/trace.ts"
import { TEST_PRICING } from "./helpers.ts"

const IMAGE = Buffer.from("synthetic image bytes ".repeat(200)).toString("base64")
const OTHER_IMAGE = Buffer.from("other synthetic image ".repeat(200)).toString("base64")
const response = { usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 5 }, complete: true }
const imageMessage = (data: string) => ({ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }, { type: "text", text: "What is this?" }] })
const anthropic = (messages: unknown[]) => ({ model: "claude-test-1", max_tokens: 100, system: "Synthetic.", messages })

function build(body: Record<string, unknown>, options: { keepBinary?: boolean; at?: number; usage?: Record<string, number> } = {}): TraceRecord {
  const record = buildRecord({
    api: "anthropic-messages",
    body,
    response: options.usage ? { usage: options.usage, complete: true } : response,
    startedAt: Date.parse("2026-01-01T10:00:00Z") + (options.at ?? 0) * 1000,
    ...(options.keepBinary ? { keepBinary: true } : {}),
  })
  if (typeof record === "string") throw new Error(record)
  return record
}

describe("binary parts", () => {
  test("are written as SHA-256 and size by default, with the block hash of the content as sent", () => {
    const elided = build(anthropic([imageMessage(IMAGE)]))
    const full = build(anthropic([imageMessage(IMAGE)]), { keepBinary: true })
    expect(JSON.stringify(elided)).not.toContain(IMAGE.slice(0, 64))
    expect(JSON.stringify(full)).toContain(IMAGE)
    expect(elided.request!.blocks.map((block) => block.hash)).toEqual(full.request!.blocks.map((block) => block.hash))
    const message = elided.request!.blocks[1]!
    expect(message.elided).toBe(true)
    expect(JSON.stringify(message.content)).toMatch(/"<binary image\/png, 4400 bytes, sha256 [0-9a-f]{64}>"/)
    expect(full.request!.blocks[1]!.elided).toBeUndefined()
    expect(elided.request!.blocks[0]!.elided).toBeUndefined()
  })

  test("an elided trace reads back without hash warnings, and an elided block needs its hash", () => {
    const parsed = parseTrace(serializeTrace([build(anthropic([imageMessage(IMAGE)]))]))
    expect(parsed.errors).toEqual([])
    expect(parsed.warnings).toEqual([])
    expect(parsed.records[0]!.request!.blocks[1]!.elided).toBe(true)
    const line = JSON.stringify({ v: 1, ts: "2026-01-01T10:00:00Z", provider: "anthropic", model: "m", fidelity: "full-request", request: { blocks: [{ kind: "message", content: { a: 1 }, elided: true }] }, usage: { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 } })
    expect(parseTrace(line).errors[0]).toContain("needs a hash: its content is elided")
  })

  test("a trace written in full and one written elided compare equal; a changed image is still a change", () => {
    const before = build(anthropic([imageMessage(IMAGE)]), { keepBinary: true })
    const after = build(anthropic([imageMessage(IMAGE), { role: "assistant", content: "A test." }, { role: "user", content: "More." }]), {
      at: 10,
      usage: { input_tokens: 3, cache_read_input_tokens: 2000, cache_creation_input_tokens: 50, output_tokens: 5 },
    })
    const turns = analyze([before, after], { pricing: parsePricing(TEST_PRICING) }).turns
    expect(turns[1]).toMatchObject({ status: "hit" })
    expect(turns[1]!.prefix_change).toBeUndefined()
    const changed = build(anthropic([imageMessage(OTHER_IMAGE)]))
    const change = comparePrefix({ model: "claude-test-1", blocks: build(anthropic([imageMessage(IMAGE)])).request!.blocks }, { model: "claude-test-1", blocks: changed.request!.blocks })
    expect(change).toMatchObject({ cause: "message_edited", block_index: 1, detail: { binary: true } })
    expect(change!.summary).toMatch(/^message #1 \(user\) edited: binary part 1 changed \(image\/png, 4,400 → 4,400 bytes, sha256 [0-9a-f]{12} → [0-9a-f]{12}\)$/)
    expect(change!.diff).toContain("sha256")
  })

  test("each provider's binary part shapes are elided; URLs and text are kept", () => {
    const parts = [
      { type: "input_image", image_url: `data:image/jpeg;base64,${IMAGE}` },
      { type: "input_image", image_url: "https://example.invalid/cat.png" },
      { type: "input_file", filename: "a.pdf", file_data: `data:application/pdf;base64,${IMAGE}` },
      { type: "image_url", image_url: { url: `data:image/webp;base64,${IMAGE}` } },
      { type: "input_audio", input_audio: { data: IMAGE, format: "wav" } },
      { type: "file", file: { file_data: IMAGE } },
      { inlineData: { mimeType: "image/png", data: IMAGE } },
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/gif", data: IMAGE } }] },
      { type: "text", text: IMAGE },
    ]
    const block = elideBinary(makeBlock("message", { role: "user", content: parts }))
    const text = JSON.stringify(block.content)
    expect(block.hash).toBe(makeBlock("message", { role: "user", content: parts }).hash)
    expect(text.split(IMAGE).length - 1).toBe(1) // only the text part keeps it
    expect(text).toContain("https://example.invalid/cat.png")
    for (const media of ["image/jpeg", "application/pdf", "image/webp", "wav", "image/png", "image/gif"]) expect(text).toContain(`<binary ${media}, 4400 bytes, sha256 `)
    expect(elideBinary(makeBlock("message", { role: "user", content: [{ type: "text", text: "hi" }] }))).not.toHaveProperty("elided")
  })
})
