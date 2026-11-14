import Anthropic from "@anthropic-ai/sdk"
import { test } from "bun:test"                    // or "node:test", vitest, jest
import { recordRequests } from "prefixlens/test"

test("Anthropic Messages: every step extends the one before it", async () => {
  const session = recordRequests()
  const client = new Anthropic({ apiKey: "test", fetch: session.fetch })

  // Stand-in for your agent: it keeps one history and sends all of it.
  const messages: Anthropic.MessageParam[] = []
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    messages.push({ role: "user", content: question })
    const reply = await client.messages.create({ model: "claude-sonnet-5-5", max_tokens: 1024, system: "You are a coding agent.", messages })
    messages.push({ role: "assistant", content: reply.content })
  }

  session.assertStable()
})
