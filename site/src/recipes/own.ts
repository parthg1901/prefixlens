import { test } from "node:test"                  // or bun:test, vitest, jest
import { assertPrefixStable } from "prefixlens/test"
import { buildRequest } from "../src/request.ts"  // your harness's own request builder

test("a new step extends the previous request", () => {
  const history = [{ role: "user", content: "Fix the failing test." }]
  const first = buildRequest(history)
  const second = buildRequest([...history, { role: "assistant", content: "Reading it now." }, { role: "user", content: "Go on." }])

  // Nothing is sent to a provider: two request bodies are compared.
  assertPrefixStable(first, second)
})
