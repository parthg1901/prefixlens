import { test } from "bun:test"                    // or "node:test", vitest, jest
import OpenAI from "openai"
import { recordRequests } from "prefixlens/test"

test("OpenAI Responses, streamed: every step extends the one before it", async () => {
  const session = recordRequests()
  const client = new OpenAI({ apiKey: "test", fetch: session.fetch })

  // Stand-in for your agent: it keeps one history and sends all of it.
  const input: OpenAI.Responses.ResponseInput = []
  for (const question of ["Where is the bug?", "Fix it.", "Add a test."]) {
    input.push({ role: "user", content: question })
    const response = await client.responses.stream({ model: "gpt-5.6", instructions: "You are a coding agent.", store: false, input }).finalResponse()
    input.push({ role: "assistant", content: response.output_text })
  }

  session.assertStable()
})
