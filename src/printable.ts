// Text taken from a trace is whatever the agent read: web pages, file contents, tool output, tool
// names from third-party servers. Written to a terminal or a CI log as it is, an escape sequence in
// it can retitle the window, recolour or hide later output, or rewrite lines already printed.

// C0 and C1 control characters and DEL, except newline and tab.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** `text` with every control character other than newline and tab written visibly, as `\x1b`. */
export function printable(text: string): string {
  return text.replace(CONTROL, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
}

/** A copy of `value` with `printable` applied to every string in it, keys included. */
export function printableDeep<T>(value: T): T {
  if (typeof value === "string") return printable(value) as T
  if (Array.isArray(value)) return value.map(printableDeep) as T
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [printable(key), printableDeep(entry)])) as T
}
