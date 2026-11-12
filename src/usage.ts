// Normalizes provider usage objects into the trace Usage shape.
//
// Anthropic reports uncached input, cache writes and cache reads separately and
// caches only up to explicit `cache_control` breakpoints, so its write figure
// is a measurement: zero means nothing was written (no breakpoint, or a prompt
// below the minimum). A response without the field wrote nothing either.
//
// OpenAI and Gemini cache prefixes automatically and report the cached part of
// an input total that already includes it. OpenAI bills writes from GPT-5.6 on
// and then reports `cache_write_tokens` in the input details (also part of the
// input total); older models, and Gemini always, report no write figure, which
// is recorded as null. A reported OpenAI figure is recorded as reported, zero
// included, but it is a billing figure, not a measure of what was cached: the
// ChatGPT sign-in backend reports zero on every call while caching the prompt.
// The analysis therefore never reads an implicit-caching provider's zero as
// "nothing was cached" (analyze.ts, expectedCached).

import { isRecord } from "./canonical.ts"
import type { Usage } from "./trace.ts"

export function normalizeUsage(provider: string, raw: unknown): Usage {
  if (!isRecord(raw)) throw new Error("usage must be an object")
  if (provider === "anthropic" || "cache_creation_input_tokens" in raw || "cache_read_input_tokens" in raw)
    return fromAnthropic(raw)
  if (provider === "gemini" || "promptTokenCount" in raw || "prompt_token_count" in raw) return fromGemini(raw)
  return fromOpenAI(raw)
}

function fromAnthropic(raw: Record<string, unknown>): Usage {
  const creation = isRecord(raw.cache_creation) ? raw.cache_creation : {}
  const oneHour = count(creation.ephemeral_1h_input_tokens)
  const details = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {}
  return {
    input_tokens: count(raw.input_tokens),
    cache_read_tokens: count(raw.cache_read_input_tokens),
    cache_write_tokens: count(raw.cache_creation_input_tokens),
    ...(oneHour > 0 ? { cache_write_1h_tokens: oneHour } : {}),
    output_tokens: count(raw.output_tokens),
    ...(details.thinking_tokens !== undefined ? { reasoning_tokens: count(details.thinking_tokens) } : {}),
  }
}

function fromOpenAI(raw: Record<string, unknown>): Usage {
  // Chat Completions: prompt_tokens / completion_tokens. Responses: input_tokens / output_tokens.
  const chat = raw.prompt_tokens !== undefined
  const total = count(chat ? raw.prompt_tokens : raw.input_tokens)
  const inputDetails = isRecord(chat ? raw.prompt_tokens_details : raw.input_tokens_details)
    ? ((chat ? raw.prompt_tokens_details : raw.input_tokens_details) as Record<string, unknown>)
    : {}
  const outputDetails = isRecord(chat ? raw.completion_tokens_details : raw.output_tokens_details)
    ? ((chat ? raw.completion_tokens_details : raw.output_tokens_details) as Record<string, unknown>)
    : {}
  const cached = Math.min(total, count(inputDetails.cached_tokens))
  // Absent (or null) means not reported; zero is kept as the provider's figure.
  const writes = inputDetails.cache_write_tokens == null ? null : Math.min(total - cached, count(inputDetails.cache_write_tokens))
  return {
    input_tokens: total - cached - (writes ?? 0),
    cache_read_tokens: cached,
    cache_write_tokens: writes,
    output_tokens: count(chat ? raw.completion_tokens : raw.output_tokens),
    ...(outputDetails.reasoning_tokens !== undefined ? { reasoning_tokens: count(outputDetails.reasoning_tokens) } : {}),
  }
}

function fromGemini(raw: Record<string, unknown>): Usage {
  const pick = (camel: string, snake: string) => count(raw[camel] ?? raw[snake])
  const prompt = pick("promptTokenCount", "prompt_token_count")
  const cached = Math.min(prompt, pick("cachedContentTokenCount", "cached_content_token_count"))
  const thoughts = pick("thoughtsTokenCount", "thoughts_token_count")
  return {
    input_tokens: prompt - cached,
    cache_read_tokens: cached,
    cache_write_tokens: null,
    output_tokens: pick("candidatesTokenCount", "candidates_token_count") + thoughts,
    ...(thoughts > 0 ? { reasoning_tokens: thoughts } : {}),
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** Input tokens the provider processed: uncached + cache read + cache write. */
export function promptTokens(usage: Usage): number {
  return usage.input_tokens + usage.cache_read_tokens + (usage.cache_write_tokens ?? 0)
}
