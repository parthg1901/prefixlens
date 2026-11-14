import Anthropic from "@anthropic-ai/sdk"
import { expect, test } from "bun:test"            // or "node:test", vitest, jest
import { callTools, recordRequests } from "prefixlens/test"

test("a tool loop keeps its prefix, and the compaction is allowed at the call where it happens", async () => {
  // After each user message the model calls read_file once; when the result comes back it answers.
  const session = recordRequests({ reply: callTools([{ name: "read_file", args: { path: "src/app.ts" } }], "Done.") })
  const client = new Anthropic({ apiKey: "test", fetch: session.fetch })
  const tools = [{ name: "read_file", description: "Read a file.", input_schema: { type: "object" as const, properties: { path: { type: "string" } } } }]

  // Stand-in for your agent: a tool loop that replaces its history with a summary once it holds eight messages.
  let messages: Anthropic.MessageParam[] = []
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    if (messages.length >= 8) messages = [{ role: "user", content: "Summary: the bug was in src/app.ts and is fixed." }, { role: "assistant", content: "Understood." }]
    messages.push({ role: "user", content: question })
    for (;;) {
      const reply = await client.messages.create({ model: "claude-sonnet-5-5", max_tokens: 1024, system: "You are a coding agent.", tools, messages })
      messages.push({ role: "assistant", content: reply.content })
      const calls = reply.content.filter((part) => part.type === "tool_use")
      if (calls.length === 0) break
      messages.push({ role: "user", content: calls.map((call) => ({ type: "tool_result" as const, tool_use_id: call.id, content: "export const app = 1" })) })
    }
  }

  // Two model calls per question. Call 5 is the first after the compaction: allowed there, and nowhere else.
  expect(session.requests).toHaveLength(6)
  expect(() => session.assertStable()).toThrow(/prefix not stable at call 5 /)
  session.assertStable({ allowBreakAt: { 5: "compaction" } })
})
