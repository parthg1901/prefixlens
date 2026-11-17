// The one rule prefixlens uses to estimate tokens where no provider counted them: four characters
// of JSON to a token. The test session reports its stand-in usage with it, and a failed assertion
// sizes its break with it. It is rough on purpose and says nothing about any tokenizer.

/** Characters of JSON per estimated token. */
export const CHARS_PER_TOKEN = 4

/** Estimated tokens in `chars` characters of JSON. */
export function tokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Estimated tokens in a value, from its JSON; never less than 1. */
export function estimateTokens(value: unknown): number {
  return Math.max(1, tokensFromChars(JSON.stringify(value)?.length ?? 0))
}
