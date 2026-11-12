// OpenTelemetry GenAI spans: an OTLP/JSON export ({ resourceSpans: [...] }),
// a JSONL file with one export (or one span) per line, or a JSON array of spans.
//
// Spans that carry gen_ai.usage.* attributes become usage-only records. The
// GenAI semantic conventions say gen_ai.usage.input_tokens includes cached
// tokens (cache_read and cache_creation), and output_tokens includes
// reasoning. Content attributes are opt-in and not the exact request, so no
// blocks are imported.

import { readFile } from "node:fs/promises"
import { isRecord } from "../canonical.ts"
import type { TraceRecord, Usage } from "../trace.ts"
import type { ImportOptions, ImportResult } from "./index.ts"
import { providerFamily } from "../provider.ts"

type Json = Record<string, unknown>
type Attributes = Record<string, unknown>

interface Span {
  span: Json
  scope?: Json
}

const CHAT_OPERATIONS = new Set(["chat", "text_completion", "generate_content"])

export async function importOtel(input: string, options: ImportOptions): Promise<ImportResult> {
  const warnings: string[] = []
  const spans = readSpans(await readFile(input, "utf8"), input, warnings)
  const usable = spans
    .map((entry) => ({ ...entry, attributes: attributesOf(entry.span.attributes) }))
    .filter((entry) => Object.keys(entry.attributes).some((key) => key.startsWith("gen_ai.usage.")))
    .filter((entry) => {
      const operation = str(entry.attributes["gen_ai.operation.name"])
      return operation === undefined || CHAT_OPERATIONS.has(operation)
    })
  if (usable.length === 0) throw new Error(`no GenAI spans with token usage found in ${input}`)
  const undated = usable.filter((entry) => startMs(entry.span.startTimeUnixNano) === undefined).length
  if (undated > 0) warnings.push(`${undated} spans have no startTimeUnixNano; skipped`)
  let excluding = 0
  const records = usable
    .flatMap((entry): TraceRecord[] => {
      const start = startMs(entry.span.startTimeUnixNano)
      if (start === undefined) return []
      const attributes = entry.attributes
      const model = str(attributes["gen_ai.request.model"]) ?? str(attributes["gen_ai.response.model"]) ?? ""
      const providerName = str(attributes["gen_ai.provider.name"]) ?? str(attributes["gen_ai.system"])
      const provider = providerOf(providerName, model)
      const usage = usageOf(attributes, provider)
      if (usage.excludesCache) excluding++
      const conversation = str(attributes["gen_ai.conversation.id"])
      const id = str(attributes["gen_ai.response.id"]) ?? str(entry.span.spanId)
      const scope = entry.scope ?? {}
      return [
        {
          v: 1,
          ...(id ? { id } : {}),
          ...(conversation ? { session: conversation } : {}),
          lane: "main",
          ts: new Date(start).toISOString(),
          provider,
          model,
          fidelity: "usage-only",
          usage: usage.usage,
          source: {
            adapter: "otel",
            ...(providerName ? { provider_name: providerName } : {}),
            ...(str(scope.name) ? { scope: str(scope.name) } : {}),
            ...(str(scope.version) ? { scope_version: str(scope.version) } : {}),
          },
        },
      ]
    })
    .filter((record) => options.session === undefined || record.session === options.session)
    .toSorted((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  if (options.session && records.length === 0) throw new Error(`conversation ${options.session} not found in ${input}`)
  warnings.push(
    "otel: instrumentations differ on whether gen_ai.usage.input_tokens includes cached tokens; assumed it does, as the GenAI semantic conventions specify",
  )
  if (excluding > 0)
    warnings.push(`${excluding} spans reported more cache tokens than input_tokens; their input_tokens was taken to exclude cached tokens`)
  return { records, warnings }
}

function readSpans(text: string, input: string, warnings: string[]): Span[] {
  const whole = parse(text)
  if (whole !== undefined) return spansOf(whole)
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  const values = lines.map(parse)
  const bad = values.filter((value) => value === undefined).length
  if (bad === lines.length) throw new Error(`${input} is neither OTLP/JSON nor JSONL`)
  if (bad > 0) warnings.push(`skipped ${bad} unreadable lines`)
  return values.flatMap((value) => (value === undefined ? [] : spansOf(value)))
}

function spansOf(value: unknown): Span[] {
  if (Array.isArray(value)) return value.flatMap(spansOf)
  if (!isRecord(value)) return []
  if (Array.isArray(value.resourceSpans))
    return value.resourceSpans.flatMap((resource) =>
      (isRecord(resource) && Array.isArray(resource.scopeSpans) ? resource.scopeSpans : []).flatMap((scopeSpans) => {
        if (!isRecord(scopeSpans) || !Array.isArray(scopeSpans.spans)) return []
        const scope = isRecord(scopeSpans.scope) ? scopeSpans.scope : undefined
        return scopeSpans.spans.filter(isRecord).map((span) => ({ span, scope }))
      }),
    )
  return "attributes" in value ? [{ span: value }] : []
}

/** OTLP attributes are a list of { key, value: AnyValue }; some exporters write a plain object instead. */
function attributesOf(value: unknown): Attributes {
  if (Array.isArray(value))
    return Object.fromEntries(
      value.filter(isRecord).flatMap((attribute) => (typeof attribute.key === "string" ? [[attribute.key, anyValue(attribute.value)]] : [])),
    )
  return isRecord(value) ? value : {}
}

function anyValue(value: unknown): unknown {
  if (!isRecord(value)) return value
  if ("stringValue" in value) return value.stringValue
  if ("intValue" in value) return Number(value.intValue)
  if ("doubleValue" in value) return Number(value.doubleValue)
  if ("boolValue" in value) return value.boolValue
  return undefined
}

function usageOf(attributes: Attributes, provider: string): { usage: Usage; excludesCache: boolean } {
  const input = count(attributes["gen_ai.usage.input_tokens"] ?? attributes["gen_ai.usage.prompt_tokens"])
  const read = count(attributes["gen_ai.usage.cache_read.input_tokens"])
  const creationValue = attributes["gen_ai.usage.cache_creation.input_tokens"]
  const creation = count(creationValue)
  const reasoning = count(attributes["gen_ai.usage.reasoning.output_tokens"])
  // Some instrumentations report input_tokens without the cached part (Anthropic's own convention).
  const excludesCache = read + creation > input
  return {
    usage: {
      input_tokens: excludesCache ? input : input - read - creation,
      cache_read_tokens: read,
      cache_write_tokens: creationValue !== undefined ? creation : provider === "anthropic" ? 0 : null,
      output_tokens: count(attributes["gen_ai.usage.output_tokens"] ?? attributes["gen_ai.usage.completion_tokens"]),
      ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
    },
    excludesCache,
  }
}

/** Maps gen_ai.provider.name (or the deprecated gen_ai.system) to the provider whose caching rules apply. */
function providerOf(name: string | undefined, model: string): string {
  const id = (name ?? "").toLowerCase()
  if (id === "anthropic" || model.toLowerCase().includes("claude")) return "anthropic"
  if (id === "openai" || id === "azure.ai.openai" || id === "az.ai.openai") return "openai"
  if (id.startsWith("gcp.") || id.includes("gemini") || id.includes("google") || id === "vertex_ai") return "gemini"
  return name ?? providerFamily("", model)
}

function startMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value / 1e6)
  if (typeof value === "string" && /^\d+$/.test(value) && value !== "0") return Number(BigInt(value) / 1_000_000n)
  return undefined
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function count(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}
