// Canonical JSON, block hashing, and provider request canonicalization.
//
// A request is turned into an ordered list of blocks in the order the provider
// assembles its prompt prefix. Each block is hashed independently so two
// requests can be compared block by block. See SPEC.md for the exact rules.

import { createHash } from "node:crypto"
import type { Block, BlockKind } from "./trace.ts"

/**
 * Serializes a JSON value with object keys sorted by UTF-16 code units and no
 * whitespace (RFC 8785 / JCS for the values JSON can carry). Keys whose value is
 * `undefined` are dropped, like JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonical JSON cannot encode NaN or Infinity")
      return JSON.stringify(value)
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`
      const object = value as Record<string, unknown>
      const keys = Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`
    }
    default:
      throw new Error(`canonical JSON cannot encode a ${typeof value}`)
  }
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of the canonical JSON of `content`. */
export function hashContent(content: unknown): string {
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex")
}

export function makeBlock(kind: BlockKind, content: unknown, key?: string, breakpoint?: boolean): Block {
  return {
    kind,
    ...(key === undefined ? {} : { key }),
    hash: hashContent(content),
    content,
    ...(breakpoint ? { breakpoint: true } : {}),
  }
}

export type Provider = "anthropic" | "openai" | "gemini"

export interface CanonicalRequest {
  model: string
  params: Record<string, unknown>
  blocks: Block[]
}

/**
 * Converts a provider request body into canonical blocks.
 * - anthropic: Messages API body (`tools`, `system`, `messages`).
 * - openai: Chat Completions body (`tools`, `messages`) or Responses body (`tools`, `instructions`, `input`).
 * - gemini: generateContent body (`tools`, `systemInstruction`, `contents`).
 */
export function canonicalizeRequest(provider: Provider, body: Record<string, unknown>): CanonicalRequest {
  const plan = draftRequest(provider, body)
  return { ...plan, blocks: plan.blocks.map(hashDraft) }
}

/**
 * `canonicalizeRequest` for a recorder that shares the event loop with open
 * streams: the same blocks, hashed one at a time with a turn of the event loop
 * between blocks, so a long request never holds other work up for longer than
 * one block takes.
 */
export async function canonicalizeRequestAsync(provider: Provider, body: Record<string, unknown>): Promise<CanonicalRequest> {
  const plan = draftRequest(provider, body)
  const blocks: Block[] = []
  for (const planned of plan.blocks) {
    blocks.push(hashDraft(planned))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { ...plan, blocks }
}

function draftRequest(provider: Provider, body: Record<string, unknown>): Plan {
  if (provider === "anthropic") return draftAnthropic(body)
  if (provider === "openai") return draftOpenAI(body)
  return draftGemini(body)
}

// A block before hashing: canonicalization is cheap, hashing is what costs on a long request.
interface Draft {
  kind: BlockKind
  content: unknown
  key?: string
  breakpoint?: boolean
}

interface Plan {
  model: string
  params: Record<string, unknown>
  blocks: Draft[]
}

function draft(kind: BlockKind, content: unknown, key?: string, breakpoint?: boolean): Draft {
  return { kind, content, ...(key === undefined ? {} : { key }), ...(breakpoint ? { breakpoint } : {}) }
}

function hashDraft(planned: Draft): Block {
  return makeBlock(planned.kind, planned.content, planned.key, planned.breakpoint)
}

// Request fields that never reach the model's prompt and so never affect caching.
const TRANSPORT_PARAMS = new Set(["stream", "stream_options"])

function paramsWithout(body: Record<string, unknown>, used: string[]) {
  return Object.fromEntries(
    Object.entries(body).filter(([key, value]) => !used.includes(key) && !TRANSPORT_PARAMS.has(key) && value !== undefined),
  )
}

export function canonicalizeAnthropic(body: Record<string, unknown>): CanonicalRequest {
  const plan = draftAnthropic(body)
  return { ...plan, blocks: plan.blocks.map(hashDraft) }
}

function draftAnthropic(body: Record<string, unknown>): Plan {
  const tools = asArray(body.tools).map((tool) => {
    const stripped = stripCacheControl(tool)
    return draft("tool", stripped.value, toolName(stripped.value), stripped.marked)
  })
  const systemBlocks = systemParts(body.system, "system").map((part) => {
    const stripped = stripCacheControl(part)
    return draft("system", stripped.value, undefined, stripped.marked)
  })
  const messages = asArray(body.messages).map((message) => {
    const normalized = normalizeMessage(message)
    return draft("message", normalized.value, roleOf(normalized.value), normalized.marked)
  })
  return {
    model: String(body.model ?? ""),
    params: paramsWithout(body, ["model", "tools", "system", "messages"]),
    blocks: [...tools, ...systemBlocks, ...messages],
  }
}

export function canonicalizeOpenAI(body: Record<string, unknown>): CanonicalRequest {
  const plan = draftOpenAI(body)
  return { ...plan, blocks: plan.blocks.map(hashDraft) }
}

function draftOpenAI(body: Record<string, unknown>): Plan {
  // OpenAI defines no cache_control, but OpenAI-compatible gateways accept Anthropic-style markers in these bodies and
  // move them between calls; they are stripped here as everywhere else so a moved marker never reads as an edit.
  const tools = [...asArray(body.tools), ...asArray(body.functions)].map((tool) => {
    const stripped = stripCacheControl(tool)
    return draft("tool", stripped.value, toolName(stripped.value), stripped.marked)
  })
  const isResponses = body.input !== undefined || body.instructions !== undefined
  if (isResponses) {
    const instructions = systemParts(body.instructions, "instructions").map((part) => {
      const stripped = stripCacheControl(part)
      return draft("system", stripped.value, undefined, stripped.marked)
    })
    const input =
      typeof body.input === "string"
        ? [{ role: "user", content: [{ type: "input_text", text: body.input }] }]
        : asArray(body.input)
    const items = leadingSystem(input.map((item) => normalizeMessage(item, (role) => (role === "assistant" ? "output_text" : "input_text"))))
    return {
      model: String(body.model ?? ""),
      params: paramsWithout(body, ["model", "tools", "functions", "instructions", "input"]),
      blocks: [...tools, ...instructions, ...items],
    }
  }
  return {
    model: String(body.model ?? ""),
    params: paramsWithout(body, ["model", "tools", "functions", "messages"]),
    blocks: [...tools, ...leadingSystem(asArray(body.messages).map((message) => normalizeMessage(message)))],
  }
}

export function canonicalizeGemini(body: Record<string, unknown>): CanonicalRequest {
  const plan = draftGemini(body)
  return { ...plan, blocks: plan.blocks.map(hashDraft) }
}

function draftGemini(body: Record<string, unknown>): Plan {
  const tools = asArray(body.tools).flatMap((tool) => {
    const record = isRecord(tool) ? tool : {}
    const declarations = asArray(record.functionDeclarations ?? record.function_declarations)
    if (declarations.length === 0) return [block("tool", stripCacheControl(tool), Object.keys(record)[0])]
    return declarations.map((declaration) => block("tool", stripCacheControl(declaration), toolName(declaration)))
  })
  const instruction = body.systemInstruction ?? body.system_instruction
  const parts = isRecord(instruction) ? asArray(instruction.parts) : typeof instruction === "string" ? [{ text: instruction }] : []
  const system = parts.map((part) => block("system", stripCacheControl(part)))
  const contents = asArray(body.contents).map((content) => block("message", stripCacheControl(content, "parts"), roleOf(content)))
  return {
    model: String(body.model ?? ""),
    params: paramsWithout(body, ["model", "tools", "systemInstruction", "system_instruction", "contents"]),
    blocks: [...tools, ...system, ...contents],
  }
}

/**
 * The block with the binary data inside its content (base64 images, documents,
 * audio and files, as each provider's part types carry them) replaced by a
 * string naming its SHA-256 and size, and `elided` set. The hash stays that of
 * the content as sent, so the block compares equal with the same block written
 * in full, and a changed image still changes the hash. Blocks without binary
 * data are returned as they are.
 */
export function elideBinary(block: Block): Block {
  if (block.content === undefined) return block
  let found = false
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (!isRecord(value)) return value
    const replaced = replaceBinary(value)
    if (replaced) {
      found = true
      return replaced
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]))
  }
  const content = walk(block.content)
  return found ? { ...block, content, elided: true } : block
}

// The part shapes that carry binary data, and where: Anthropic image/document sources, OpenAI Responses
// input_image/input_file, Chat Completions image_url/input_audio/file, Gemini inlineData.
function replaceBinary(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const at = (object: unknown, key: string, transform: (text: string) => string | undefined) => {
    if (!isRecord(object) || typeof object[key] !== "string") return undefined
    const next = transform(object[key])
    return next === undefined ? undefined : { ...object, [key]: next }
  }
  const nested = (key: string, field: string, transform: (text: string) => string | undefined) => {
    const inner = at(part[key], field, transform)
    return inner === undefined ? undefined : { ...part, [key]: inner }
  }
  if (isRecord(part.source) && part.source.type === "base64") return nested("source", "data", (data) => binaryMarker(data, stringOf(part.source, "media_type")))
  if (part.type === "input_image") return at(part, "image_url", dataUrlMarker)
  if (part.type === "input_file") return at(part, "file_data", (data) => dataUrlMarker(data) ?? binaryMarker(data))
  if (part.type === "image_url") return nested("image_url", "url", dataUrlMarker)
  if (part.type === "input_audio") return nested("input_audio", "data", (data) => binaryMarker(data, stringOf(part.input_audio, "format")))
  if (part.type === "file") return nested("file", "file_data", (data) => dataUrlMarker(data) ?? binaryMarker(data))
  for (const key of ["inlineData", "inline_data"])
    if (isRecord(part[key])) return nested(key, "data", (data) => binaryMarker(data, stringOf(part[key], "mimeType") ?? stringOf(part[key], "mime_type")))
  return undefined
}

/** "<binary image/png, 12345 bytes, sha256 …>": the SHA-256 is of the base64 text as sent, the size that of the decoded bytes. */
function binaryMarker(base64: string, mediaType?: string): string {
  const bytes = Math.floor((base64.replace(/[^A-Za-z0-9+/]/g, "").length * 3) / 4)
  return `<binary${mediaType ? ` ${mediaType}` : ""}, ${bytes} bytes, sha256 ${createHash("sha256").update(base64, "utf8").digest("hex")}>`
}

// Only data: URLs carry the bytes; an http(s) URL is kept as it is.
function dataUrlMarker(url: string): string | undefined {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,/.exec(url)
  return match ? binaryMarker(url.slice(match[0].length), match[1] || undefined) : undefined
}

function stringOf(object: unknown, key: string): string | undefined {
  return isRecord(object) && typeof object[key] === "string" ? object[key] : undefined
}

/**
 * Removes `cache_control` from an object and from each element of its `content`
 * array. Breakpoint placement moves between requests and is not part of the
 * cached content, so it must not change a block's hash.
 */
export function stripCacheControl(value: unknown, partsKey: "content" | "parts" = "content"): { value: unknown; marked: boolean } {
  if (!isRecord(value)) return { value, marked: false }
  const { cache_control, ...rest } = value
  const list = rest[partsKey]
  if (!Array.isArray(list)) return { value: rest, marked: cache_control !== undefined }
  const parts = list.map((part) => stripCacheControl(part))
  return {
    value: { ...rest, [partsKey]: parts.map((part) => part.value) },
    marked: cache_control !== undefined || parts.some((part) => part.marked),
  }
}

function block(kind: BlockKind, stripped: { value: unknown; marked: boolean }, key?: string): Draft {
  return draft(kind, stripped.value, key, stripped.marked)
}

/**
 * The parts of a system prompt field (Anthropic `system`, Responses
 * `instructions`): a string is one text part, an array is its elements,
 * null or absent is none. Any other value is not a documented form; it is
 * kept whole as one part, as sent, so that nothing the provider received is
 * silently left out of the comparison.
 */
function systemParts(value: unknown, field: "system" | "instructions"): unknown[] {
  if (value === undefined || value === null) return []
  if (typeof value === "string") return [{ type: "text", text: value }]
  // Anthropic documents `system` as a string or a list of text parts; Responses documents `instructions` as a string only.
  if (Array.isArray(value) && field === "system") return value
  return [value]
}

// A string message body and a single text part render the same prompt, so both
// canonicalize to the part form; this keeps a harmless representation change
// from reading as an edited message.
function normalizeMessage(message: unknown, textType: (role: unknown) => string = () => "text") {
  const stripped = stripCacheControl(message)
  if (!isRecord(stripped.value) || typeof stripped.value.content !== "string") return stripped
  const part = { type: textType(stripped.value.role), text: stripped.value.content }
  return { value: { ...stripped.value, content: [part] }, marked: stripped.marked }
}

// System and developer messages before the first other message are the system
// prompt; later ones are part of the conversation and stay message blocks.
function leadingSystem(messages: { value: unknown; marked: boolean }[]): Draft[] {
  const firstOther = messages.findIndex((message) => !["system", "developer"].includes(roleOf(message.value) ?? ""))
  const cut = firstOther === -1 ? messages.length : firstOther
  return messages.map((message, index) => block(index < cut ? "system" : "message", message, roleOf(message.value) ?? typeOf(message.value)))
}

function toolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined
  if (typeof tool.name === "string") return tool.name
  if (isRecord(tool.function) && typeof tool.function.name === "string") return tool.function.name
  if (typeof tool.type === "string") return tool.type
  return undefined
}

function roleOf(message: unknown): string | undefined {
  return isRecord(message) && typeof message.role === "string" ? message.role : undefined
}

function typeOf(message: unknown): string | undefined {
  return isRecord(message) && typeof message.type === "string" ? message.type : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
