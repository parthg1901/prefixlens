import { createAnthropic } from "@ai-sdk/anthropic"
import { Agent } from "@mastra/core/agent"
import { LibSQLStore } from "@mastra/libsql"
import { Memory } from "@mastra/memory"
import { test } from "node:test"                  // or bun:test, vitest, jest
import { recordRequests } from "prefixlens/test"

test("the agent keeps its prefix through a long thread", async () => {
  const session = recordRequests()
  const model = createAnthropic({ apiKey: "test", fetch: session.fetch })("claude-sonnet-5-5")
  const agent = new Agent({
    id: "support",
    name: "support",
    instructions: "You are a support agent.",
    model,
    memory: new Memory({ storage: new LibSQLStore({ id: "test", url: ":memory:" }) }),
  })

  // Long enough to pass any history window: 8 questions are 16 stored messages.
  for (let turn = 1; turn <= 8; turn++) {
    await agent.generate(`Question ${turn}`, { memory: { thread: "thread-1", resource: "user-1" } })
  }

  session.assertStable()
})
