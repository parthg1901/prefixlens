// Conversations the provider keeps. A request that continues one carries only
// what is new: the provider puts the earlier turns in front of it. Such a
// request is not meant to extend the one before it, so comparing the two would
// report a break where there is none. prefixlens does not compare it, and says so.

export interface KeptConversation {
  /** The request field that names it, for messages: "Anthropic's `thread`". */
  by: string
  /** The reply, or the conversation, the request continues. */
  id: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const idOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined)

/**
 * How a request continues a conversation the provider keeps, read from its top-level fields (a request
 * body, or the `params` of a canonical request or a trace record); undefined when it carries the
 * conversation itself. Anthropic Messages: `thread: { type: "continue", previous_message_id }` (a
 * `create` is sent in full). OpenAI Responses: `previous_response_id`, or `conversation`.
 */
export function keptConversation(fields: Record<string, unknown> | undefined): KeptConversation | undefined {
  if (!fields) return undefined
  const thread = fields.thread
  if (isRecord(thread) && thread.type === "continue") return { by: "Anthropic's `thread`", id: idOf(thread.previous_message_id) ?? "" }
  const response = idOf(fields.previous_response_id)
  if (response) return { by: "OpenAI's `previous_response_id`", id: response }
  const conversation = idOf(fields.conversation) ?? (isRecord(fields.conversation) ? idOf(fields.conversation.id) : undefined)
  if (conversation) return { by: "OpenAI's `conversation`", id: conversation }
  return undefined
}
