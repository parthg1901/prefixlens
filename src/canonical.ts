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
  if (provider === "anthropic") return canonicalizeAnthropic(body)
  if (provider === "openai") return canonicalizeOpenAI(body)
  return canonicalizeGemini(body)
}

// Request fields that never reach the model's prompt and so never affect caching.
const TRANSPORT_PARAMS = new Set(["stream", "stream_options"])

function paramsWithout(body: Record<string, unknown>, used: string[]) {
  return Object.fromEntries(
    Object.entries(body).filter(([key, value]) => !used.includes(key) && !TRANSPORT_PARAMS.has(key) && value !== undefined),
  )
}

export function canonicalizeAnthropic(body: Record<string, unknown>): CanonicalRequest {
  const tools = asArray(body.tools).map((tool) => {
    const stripped = stripCacheControl(tool)
    return makeBlock("tool", stripped.value, toolName(stripped.value), stripped.marked)
  })
  const system = typeof body.system === "string" ? [{ type: "text", text: body.system }] : asArray(body.system)
  const systemBlocks = system.map((part) => {
    const stripped = stripCacheControl(part)
    return makeBlock("system", stripped.value, undefined, stripped.marked)
  })
  const messages = asArray(body.messages).map((message) => {
    const normalized = normalizeMessage(message)
    return makeBlock("message", normalized.value, roleOf(normalized.value), normalized.marked)
  })
  return {
    model: String(body.model ?? ""),
    params: paramsWithout(body, ["model", "tools", "system", "messages"]),
    blocks: [...tools, ...systemBlocks, ...messages],
  }
}

export function canonicalizeOpenAI(body: Record<string, unknown>): CanonicalRequest {
  const tools = [...asArray(body.tools), ...asArray(body.functions)].map((tool) =>
    makeBlock("tool", tool, toolName(tool)),
  )
  const isResponses = body.input !== undefined || body.instructions !== undefined
  if (isResponses) {
    const instructions =
      typeof body.instructions === "string" ? [makeBlock("system", { type: "text", text: body.instructions })] : []
    const input =
      typeof body.input === "string"
        ? [{ role: "user", content: [{ type: "input_text", text: body.input }] }]
        : asArray(body.input)
    const items = input.map((item) => {
      const normalized = normalizeMessage(item, (role) => (role === "assistant" ? "output_text" : "input_text")).value
      const role = roleOf(normalized)
      return makeBlock(role === "system" || role === "developer" ? "system" : "message", normalized, role ?? typeOf(normalized))
    })
    return {
      model: String(body.model ?? ""),
      params: paramsWithout(body, ["model", "tools", "functions", "instructions", "input"]),
      blocks: [...tools, ...instructions, ...items],
    }
  }
  const messages = asArray(body.messages).map((message) => {
    const normalized = normalizeMessage(message).value
    const role = roleOf(normalized)
    return makeBlock(role === "system" || role === "developer" ? "system" : "message", normalized, role)
  })
  return {
    model: String(body.model ?? ""),
    params: paramsWithout(body, ["model", "tools", "functions", "messages"]),
    blocks: [...tools, ...messages],
  }
}

export function canonicalizeGemini(body: Record<string, unknown>): CanonicalRequest {
  const tools = asArray(body.tools).flatMap((tool) => {
    const record = isRecord(tool) ? tool : {}
    const declarations = asArray(record.functionDeclarations ?? record.function_declarations)
    if (declarations.length === 0) return [makeBlock("tool", tool, Object.keys(record)[0])]
    return declarations.map((declaration) => makeBlock("tool", declaration, toolName(declaration)))
  })
  const instruction = body.systemInstruction ?? body.system_instruction
  const systemParts = isRecord(instruction) ? asArray(instruction.parts) : typeof instruction === "string" ? [{ text: instruction }] : []
  const system = systemParts.map((part) => makeBlock("system", part))
  const contents = asArray(body.contents).map((content) => makeBlock("message", content, roleOf(content)))
  return {
    model: String(body.model ?? ""),
    params: paramsWithout(body, ["model", "tools", "systemInstruction", "system_instruction", "contents"]),
    blocks: [...tools, ...system, ...contents],
  }
}

/**
 * Removes `cache_control` from an object and from each element of its `content`
 * array. Breakpoint placement moves between requests and is not part of the
 * cached content, so it must not change a block's hash.
 */
export function stripCacheControl(value: unknown): { value: unknown; marked: boolean } {
  if (!isRecord(value)) return { value, marked: false }
  const { cache_control, ...rest } = value
  if (!Array.isArray(rest.content)) return { value: rest, marked: cache_control !== undefined }
  const parts = rest.content.map((part) => stripCacheControl(part))
  return {
    value: { ...rest, content: parts.map((part) => part.value) },
    marked: cache_control !== undefined || parts.some((part) => part.marked),
  }
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
