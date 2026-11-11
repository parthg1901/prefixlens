import { describe, expect, test } from "bun:test"
import {
  canonicalizeAnthropic,
  canonicalizeGemini,
  canonicalizeOpenAI,
  canonicalJson,
  hashContent,
  stripCacheControl,
} from "../src/canonical.ts"
import { body, SYSTEM, TOOLS, user } from "./helpers.ts"

describe("canonicalJson", () => {
  test("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
  })

  test("keeps array order and encodes primitives like JSON", () => {
    expect(canonicalJson([true, null, 1.5, "é\n", 1e21, -0])).toBe('[true,null,1.5,"é\\n",1e+21,0]')
  })

  test("drops undefined object values and encodes undefined array items as null", () => {
    expect(canonicalJson({ a: undefined, b: [undefined] })).toBe('{"b":[null]}')
  })

  test("sorts keys by UTF-16 code units, not locale", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, "é": 4 })).toBe('{"B":2,"a":3,"b":1,"é":4}')
  })

  test("rejects values JSON cannot carry", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow()
    expect(() => canonicalJson({ f: () => 1 })).toThrow()
  })
})

describe("hashContent", () => {
  // These vectors are also listed in SPEC.md so other implementations can check themselves.
  test("is SHA-256 hex of the canonical JSON", () => {
    expect(hashContent({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862")
    expect(hashContent({ type: "custom", name: "read_file" })).toBe("5d364be90495295000470579a9553503093c9e3b7d035f94f0626e24de3693e1")
    expect(hashContent({ role: "user", content: [{ type: "text", text: "hi" }] })).toBe(
      "da3ac0b4d79dbe28c3c6684e1e4d037992df0e519e410c56436a23ecadf5c3c1",
    )
  })

  test("does not depend on key order", () => {
    expect(hashContent({ x: 1, y: [1, 2] })).toBe(hashContent({ y: [1, 2], x: 1 }))
  })
})

describe("canonicalizeAnthropic", () => {
  test("orders blocks tools, then system, then messages", () => {
    const request = canonicalizeAnthropic(body([user("hello"), { role: "assistant", content: "hi" }]))
    expect(request.blocks.map((block) => block.kind)).toEqual(["tool", "tool", "tool", "system", "message", "message"])
    expect(request.blocks.slice(0, 3).map((block) => block.key)).toEqual(TOOLS.map((tool) => tool.name))
    expect(request.blocks[4]!.key).toBe("user")
  })

  test("puts everything except tools, system and messages into params, minus transport fields", () => {
    const request = canonicalizeAnthropic(body([user("x")], { stream: true, thinking: { type: "adaptive" } }))
    expect(request.model).toBe("claude-test-1")
    expect(request.params).toEqual({ max_tokens: 1000, thinking: { type: "adaptive" } })
  })

  test("a string body and a single text part hash the same", () => {
    const a = canonicalizeAnthropic(body([user("same words")], { system: SYSTEM }))
    const b = canonicalizeAnthropic(
      body([{ role: "user", content: [{ type: "text", text: "same words" }] }], { system: [{ type: "text", text: SYSTEM }] }),
    )
    expect(a.blocks.map((block) => block.hash)).toEqual(b.blocks.map((block) => block.hash))
  })

  test("cache_control does not change hashes but marks the block as a breakpoint", () => {
    const plain = canonicalizeAnthropic(body([user("q")]))
    const marked = canonicalizeAnthropic(
      body([{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }], {
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
      }),
    )
    expect(marked.blocks.map((block) => block.hash)).toEqual(plain.blocks.map((block) => block.hash))
    expect(marked.blocks.filter((block) => block.breakpoint).map((block) => block.kind)).toEqual(["system", "message"])
    expect(plain.blocks.some((block) => block.breakpoint)).toBe(false)
  })

  test("tolerates a request without tools or system", () => {
    const request = canonicalizeAnthropic({ model: "m", messages: [user("x")] })
    expect(request.blocks).toHaveLength(1)
  })
})

describe("stripCacheControl", () => {
  test("strips the top level and content parts only", () => {
    const stripped = stripCacheControl({
      cache_control: { type: "ephemeral" },
      input_schema: { cache_control: "kept: not a marker at this depth" },
      content: [{ type: "text", text: "a", cache_control: {} }],
    })
    expect(stripped.marked).toBe(true)
    expect(stripped.value).toEqual({ input_schema: { cache_control: "kept: not a marker at this depth" }, content: [{ type: "text", text: "a" }] })
  })
})

describe("canonicalizeOpenAI", () => {
  test("chat completions: tools first, leading system and developer messages as system blocks", () => {
    const request = canonicalizeOpenAI({
      model: "gpt-test",
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "result" },
      ],
      stream: true,
      temperature: 0,
    })
    expect(request.blocks.map((block) => [block.kind, block.key])).toEqual([
      ["tool", "lookup"],
      ["system", "system"],
      ["message", "user"],
      ["message", "assistant"],
      ["message", "tool"],
    ])
    expect(request.params).toEqual({ temperature: 0 })
  })

  test("a system message later in the conversation stays a message block, keeping prefix order", () => {
    const request = canonicalizeOpenAI({
      model: "gpt-test",
      messages: [
        { role: "developer", content: "rules" },
        { role: "user", content: "hi" },
        { role: "system", content: "mode changed" },
      ],
    })
    expect(request.blocks.map((block) => block.kind)).toEqual(["system", "message", "message"])
  })

  test("responses api: instructions become the system block and input items become messages", () => {
    const request = canonicalizeOpenAI({
      model: "gpt-test",
      instructions: "rules",
      input: [{ role: "user", content: "hi" }, { type: "function_call_output", call_id: "c1", output: "ok" }],
    })
    expect(request.blocks.map((block) => [block.kind, block.key])).toEqual([
      ["system", undefined],
      ["message", "user"],
      ["message", "function_call_output"],
    ])
    expect(request.blocks[1]!.content).toEqual({ role: "user", content: [{ type: "input_text", text: "hi" }] })
  })

  test("responses api: a plain string input is one user message", () => {
    const request = canonicalizeOpenAI({ model: "gpt-test", input: "hi" })
    expect(request.blocks).toHaveLength(1)
    expect(request.blocks[0]!.key).toBe("user")
  })
})

describe("canonicalizeGemini", () => {
  test("splits function declarations into one block per tool", () => {
    const request = canonicalizeGemini({
      tools: [{ functionDeclarations: [{ name: "a" }, { name: "b" }] }, { googleSearch: {} }],
      systemInstruction: { parts: [{ text: "rules" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0 },
    })
    expect(request.blocks.map((block) => [block.kind, block.key])).toEqual([
      ["tool", "a"],
      ["tool", "b"],
      ["tool", "googleSearch"],
      ["system", undefined],
      ["message", "user"],
    ])
    expect(request.params).toEqual({ generationConfig: { temperature: 0 } })
  })
})
