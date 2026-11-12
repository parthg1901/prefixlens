// Which request parameters are part of the cached prompt prefix, per provider,
// and how sure prefixlens is of each answer. SPEC.md section 8.1 is the
// human-readable form of this table; keep the two in step.
//
// A parameter is classified by its top-level request key. Each rule says
// whether a change to it can cost cached tokens ("prefix") or not ("none"),
// from which part of the prompt a change invalidates the cache, and the
// evidence: "verified" (measured against the live API), "documented" (the
// provider's prompt-caching documentation says so) or "assumed".

export type ParamEffect = "prefix" | "none"
export type Evidence = "verified" | "documented" | "assumed"
/** Where a change to the parameter starts invalidating: everything, the system prompt on, or the messages on. */
export type InvalidatesFrom = "start" | "system" | "messages"

export interface ParamRule {
  effect: ParamEffect
  /** For "prefix" rules: the first part of the prompt a change invalidates. */
  from?: InvalidatesFrom
  evidence: Evidence
  /** Where the classification comes from, in a few words. */
  basis: string
}

const SAMPLING_BASIS = "sampling and output limits apply after the prompt is read; not listed by the provider as affecting the cache"

// Sampling, output limits and bookkeeping: applied after the prompt is read, so they cannot change the cached prefix.
const OUTPUT_ONLY = ["max_tokens", "max_output_tokens", "max_completion_tokens", "temperature", "top_p", "top_k", "stop", "stop_sequences", "n", "seed", "logprobs", "top_logprobs", "metadata", "user", "stream", "stream_options"]

/**
 * Request fields that identify a person, an account, a device or an
 * installation, and are not model input: Anthropic's `metadata.user_id`
 * (Claude Code puts its account id, a persistent device id and the session id
 * there), OpenAI's `metadata`, `user` and `safety_identifier`, and Codex's
 * `client_metadata`. Recorders leave them out of `params` unless asked to keep
 * them. `prompt_cache_key` and the `session-id` header are not here: they are
 * cache-routing keys the analysis needs (SPEC 2, 8.1).
 */
export const IDENTIFYING_PARAMS = ["metadata", "user", "safety_identifier", "client_metadata"]

/** `params` without the identifying fields, unless `keep` is set. */
export function withoutIdentifiers(params: Record<string, unknown>, keep = false): Record<string, unknown> {
  if (keep) return params
  return Object.fromEntries(Object.entries(params).filter(([key]) => !IDENTIFYING_PARAMS.includes(key)))
}

const none = (evidence: Evidence, basis: string): ParamRule => ({ effect: "none", evidence, basis })
const prefix = (from: InvalidatesFrom, evidence: Evidence, basis: string): ParamRule => ({ effect: "prefix", from, evidence, basis })

const COMMON: Record<string, ParamRule> = Object.fromEntries(OUTPUT_ONLY.map((key) => [key, none("assumed", SAMPLING_BASIS)]))

const ANTHROPIC_DOCS = "Anthropic prompt-caching docs, \"What invalidates the cache\""
const OPENAI_DOCS = "OpenAI prompt-caching guide, \"Which settings affect the cached prefix?\""

export const PARAM_RULES: Record<string, Record<string, ParamRule>> = {
  anthropic: {
    ...COMMON,
    tool_choice: prefix("messages", "documented", `${ANTHROPIC_DOCS}: changes to tool_choice only affect message blocks`),
    thinking: prefix("start", "documented", `${ANTHROPIC_DOCS}: always invalidates messages; tools and system too on models that render it ahead of them`),
    output_config: prefix("start", "documented", `${ANTHROPIC_DOCS}: output_config.effort, same reach as thinking parameters`),
    speed: prefix("system", "documented", `${ANTHROPIC_DOCS}: invalidates system and message caches`),
    context_management: prefix("start", "assumed", "server-side context editing changes what the model reads"),
    mcp_servers: prefix("start", "assumed", "MCP servers add tools to the prompt"),
    service_tier: none("assumed", "billing and capacity only"),
  },
  openai: {
    ...COMMON,
    tool_choice: none("verified", "measured on the Responses API: a warm 5,159-token prefix read 4,992 cached tokens with \"auto\", \"none\" and \"auto\" again; assumed the same on Chat Completions"),
    parallel_tool_calls: prefix("start", "documented", `${OPENAI_DOCS}: can change instructions about calling multiple tools`),
    reasoning: prefix("start", "documented", `${OPENAI_DOCS}: reasoning.effort can change model-side reasoning instructions`),
    reasoning_effort: prefix("start", "assumed", "Chat Completions name for the reasoning effort the guide documents"),
    text: prefix("start", "documented", `${OPENAI_DOCS}: text.verbosity and text.format change instructions`),
    verbosity: prefix("start", "assumed", "Chat Completions name for the verbosity the guide documents"),
    response_format: prefix("start", "assumed", "Chat Completions name for the structured-output format the guide documents"),
    context_management: prefix("start", "documented", `${OPENAI_DOCS}: compaction replaces earlier conversation content`),
    prompt_cache_key: prefix("start", "documented", "OpenAI prompt-caching guide: keys influence routing to a cache"),
    prompt_cache_options: none("assumed", "selects which breakpoints are written (mode), their minimum lifetime (ttl) and diagnostics (comparison_response_id, a new id on every call); a read still needs the rendered prefix to match"),
    prompt_cache_retention: none("assumed", "a maximum retention policy (deprecated for prompt_cache_options.ttl); does not change the prompt"),
    user: prefix("start", "documented", "OpenAI API reference: `user` is used to bucket similar requests for cache hits, and is deprecated in favour of prompt_cache_key"),
    store: none("assumed", "response storage only"),
    include: none("assumed", "selects response fields only"),
    service_tier: none("assumed", "billing and capacity only"),
    safety_identifier: none("assumed", "abuse monitoring only"),
    background: none("assumed", "response delivery only"),
  },
  gemini: { ...COMMON },
}

/** The rule for a parameter nobody classified: assumed cache-relevant from the start, so a change is never silently ignored. */
export const UNKNOWN_PARAM: ParamRule = prefix("start", "assumed", "not classified; assumed cache-relevant so that a change is never ignored")

/** How a request parameter of `provider` relates to the cached prefix. Unknown providers get the common rules. */
export function paramRule(provider: string | undefined, key: string): ParamRule {
  return PARAM_RULES[provider ?? ""]?.[key] ?? COMMON[key] ?? UNKNOWN_PARAM
}
