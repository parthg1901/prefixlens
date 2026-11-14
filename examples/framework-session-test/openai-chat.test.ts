import { test } from "bun:test"                    // or "node:test", vitest, jest
import OpenAI from "openai"
import { recordRequests } from "prefixlens/test"

test("OpenAI Chat Completions: every step extends the one before it", async () => {
  const session = recordRequests()
  const client = new OpenAI({ apiKey: "test", fetch: session.fetch })

  // Stand-in for your agent: it keeps one history and sends all of it.
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: "You are a coding agent." }]
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    messages.push({ role: "user", content: question })
    const completion = await client.chat.completions.create({ model: "gpt-5.6", messages })
    messages.push(completion.choices[0]!.message)
  }

  session.assertStable()
})
