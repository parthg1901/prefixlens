// A toy harness request builder for the OpenAI Responses API. Each option
// switches on one of the bugs that silently break prompt caching.

export interface Tool {
  name: string
  description: string
}

export interface Turn {
  role: "user" | "assistant"
  text: string
}

export interface BuildOptions {
  /** Bug: tools come out of a Set filled in connection order, so their order changes. */
  shuffleTools?: boolean
  /** Bug: the system prompt carries the current time. */
  now?: Date
  /** Bug: old assistant replies are "tidied" on replay. */
  tidyHistory?: boolean
  /** Bug: plan mode hides the write tools instead of refusing them. */
  mode?: "build" | "plan"
}

const TOOLS: Tool[] = [
  { name: "read_file", description: "Read a file." },
  { name: "write_file", description: "Write a file." },
  { name: "run_shell", description: "Run a shell command." },
]

export function buildRequest(history: Turn[], options: BuildOptions = {}) {
  const available = options.mode === "plan" ? TOOLS.filter((tool) => tool.name === "read_file") : TOOLS
  // Stands in for MCP servers connecting in a different order each time.
  const shift = history.length % available.length
  const tools = options.shuffleTools ? [...available.slice(shift), ...available.slice(0, shift)] : available
  const latestReply = history.findLastIndex((turn) => turn.role === "assistant")
  return {
    model: "gpt-6-luna",
    store: false,
    stream: true,
    instructions: `You are a careful coding agent.${options.now ? ` The time is ${options.now.toISOString()}.` : ""}`,
    tools: tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: { type: "object" }, strict: false })),
    input: history.map((turn, index) =>
      turn.role === "user"
        ? { type: "message", role: "user", content: [{ type: "input_text", text: turn.text }] }
        : {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: options.tidyHistory && index < latestReply ? turn.text.trim() : turn.text }],
          },
    ),
  }
}
