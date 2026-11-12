// Which provider's caching rules a model follows, from the id a harness logged it under and the
// model's name: shared by the importers and `prefixlens pricing show`.

/**
 * The trace provider (SPEC 2: whose caching rules apply) for a harness's provider id and model:
 * `anthropic` for Claude models wherever they are served (Bedrock, Vertex, a router), `openai` for
 * GPT and o-series models and Azure, `gemini` for Google's; any other provider id as it is.
 */
export function providerFamily(provider: string, model: string): string {
  const id = provider.toLowerCase()
  const name = model.toLowerCase()
  if (id === "anthropic" || id.includes("bedrock") || id.includes("vertex-anthropic") || name.includes("claude")) return "anthropic"
  if (id === "openai" || id === "azure" || name.startsWith("gpt-") || /^o\d/.test(name)) return "openai"
  if (id.startsWith("google") || name.startsWith("gemini")) return "gemini"
  return id
}
