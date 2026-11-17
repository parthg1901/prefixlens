import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText, stepCountIs, tool, type ModelMessage } from "ai"
import { test } from "node:test"                  // or bun:test, vitest, jest
import { callTools, recordRequests } from "prefixlens/test"
import { z } from "zod"

test("the agent keeps its prefix across turns and tool calls", async () => {
  // The session stands in for the provider: after each user message the model calls read_file once, then answers.
  const session = recordRequests({ reply: callTools([{ name: "read_file", args: { path: "src/app.ts" } }], "Done.") })
  const model = createAnthropic({ apiKey: "test", fetch: session.fetch })("claude-sonnet-5-5")
  const tools = {
    read_file: tool({ description: "Read a file.", inputSchema: z.object({ path: z.string() }), execute: async () => "export const app = 1" }),
  }

  // Your agent loop goes here. This one keeps one history and sends all of it.
  const messages: ModelMessage[] = []
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    messages.push({ role: "user", content: question })
    const result = await generateText({ model, system: "You are a coding agent.", tools, messages, stopWhen: stepCountIs(5) })
    messages.push(...result.responseMessages)
  }

  session.assertStable()
})
