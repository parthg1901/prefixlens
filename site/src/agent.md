# Add a prompt-cache regression test with prefixlens

This repository sends requests to an LLM API, directly or through a framework. Add a test that fails when a code change breaks the provider's prompt cache. Use prefixlens: the npm package `prefixlens`, at exactly version {{version}} (https://github.com/parthg1901/prefixlens).

Why it matters: a provider caches the start of a request. When anything early in the request differs from the previous call of the same conversation (the tool list or its order, the system prompt, an earlier message), everything after that point is billed at full price, and nothing reports it. prefixlens compares consecutive requests and names the first block that changed.

## 1. Understand the harness

Before you write anything, read the code that builds and sends model requests, and find out:

- **Where the conversation lives.** Is it sent in full with every request, or does the provider keep it (Anthropic's `thread`, OpenAI's `previous_response_id` or `conversation`)?
- **What trims it.** A history window, a compaction, a token limit.
- **What can change a request during a session.** Find every such thing this harness has, not a sample of them: reminders, memory and reloaded instructions are only the common ones.
- **Where cache breakpoints are set**, if the code sets any (`cache_control`, a cache key).

Write what you found in a few lines; they open your report. The list of what can change a request is what the test has to cover.

When the provider keeps the conversation, a request carries only what is new. Consecutive requests are then not meant to extend each other, and prefixlens cannot judge them. Test the path that sends the conversation in full, if the harness has a setting for it, and say in your report that the path the provider keeps is not covered. With no such setting, stop and say so.

## 2. Decide which case this is

- **Case A: the project builds the request body itself.** There is a function that returns the body for the Anthropic Messages, OpenAI Chat Completions or OpenAI Responses API.
- **Case B: a framework or an SDK builds it.** The Vercel AI SDK, Mastra, LangChain, or a provider's SDK called from an agent loop.
- **Case C: the project is not JavaScript or TypeScript.** The test helpers are JavaScript, so the project's own tests capture the request bodies and a small Node script checks them.

When A and B are both true, do case B on the main agent loop: it covers more.

## 3. Install

Add `prefixlens` as a dev dependency at exactly version {{version}}, with the package manager the project already uses (for example `npm install --save-dev --save-exact prefixlens@{{version}}`), and keep the lockfile change. It needs Node.js 22 or later, or Bun, and has no dependencies of its own. In case C nothing is installed: step 4 runs prefixlens with `npx` at that exact version.

## 4. Write the test

Use the project's own test runner and put the test beside its other tests. Build the agent the way production does: the real system prompt, tools, memory and history settings. A simplified copy protects nothing. Exercise everything from step 1 that can change a request; what one conversation cannot hold goes in a second one. Writing the test should not need a change to the project's own code.

Case A, two consecutive requests of one conversation:

```ts
import { assertPrefixStable } from "prefixlens/test"

const first = buildRequest(conversation)                    // the project's own request builder
const second = buildRequest([...conversation, ...nextStep])  // the same conversation, one step later
assertPrefixStable(first, second)
```

Cover a second user turn, a tool call with its result, and anything the project adds during a session (reminders, memory, changed instructions).

Case B, a whole run with a stand-in provider:

```ts
import { callTools, recordRequests } from "prefixlens/test"

// The session answers every model call itself: no network, no API key, no cost.
const session = recordRequests({ reply: callTools([{ name: "<one of the agent's tools>", args: {} }]) })
// Hand session.fetch to the model provider the agent uses. Take the first of these that applies:
//   1. The code already accepts a fetch function or a client: pass it.
//        createAnthropic({ apiKey: "test", fetch: session.fetch })      Vercel AI SDK, Mastra
//        new OpenAI({ apiKey: "test", fetch: session.fetch })           a provider's SDK
//   2. It does not: replace the global fetch for this test only. Set it and the provider's API key
//      variable ("test") before the agent's module is imported, and put the real fetch back afterwards.
//        globalThis.fetch = session.fetch
//   3. Neither works: stop and ask before changing the project's code (see Rules).
// Then run the real agent in one conversation for at least eight user turns,
// so that a history window or a compaction, if there is one, is reached.
// Name each thing the test does before it does it, one name for each item of your step 1 list:
session.step("first question")
// ... the agent's turn ...
session.step("reload instructions")
// ... the change, then the agent's turn ...
session.assertStable()
```

A failure then names the step, and one run reports every step that broke. `session.summary().text` is the same result as a table, one row for each step.

Case C, request bodies captured by the project's own tests. Nothing is added to the repository, but the test now needs Node.js 22 or later where it runs: tell the user, and ask before making the tests depend on it.

1. In the project's test runner, write a test that collects the JSON bodies of consecutive model requests of one conversation, in the order they are sent and exactly as they go to the provider. Either call the project's request builder for each step, as in case A, or run the agent against the fake provider or the HTTP mock its tests already use and capture each body, as in case B, for at least eight user turns.
2. In the test, write the bodies to a temporary file, as one JSON array or one body on each line, and run:

```
npx --yes prefixlens@{{version}} check --requests <file>
```

3. Fail the test when the command exits with anything but 0, showing what it printed. That output is prefixlens's message. It exits 1 for a cache break and 2 when the bodies could not be checked.

When the tests cannot produce request bodies without a real provider, stop and tell the user. The other route records a real run through a local proxy (`npx prefixlens record`, then `npx prefixlens check` on the trace); it makes real model calls, so set it up only when the user asks for it.

## 5. Run it

- **It passes.** Go to step 6.
- **It fails.** The message names the step and the call, the first changed block, about how many tokens the break re-reads and what that costs at list prices, a diff and a fix. Almost always that is a real cache break in this project, not a problem with the test: do not loosen the test, shorten the run or change the agent's settings to make it pass. When what you learned in step 1 says the change cannot cost a cache read, do not allow it on your own either: show the user the message and your reasoning.
  - When the fix looks small (a timestamp or an id in the system prompt, tools sent in an unstable order), show it to the user as a diff and ask before applying it. Keep what the model needs: fix a value once per session or send it in a new message, and delete it only when nothing uses it. When the user has already told you to apply fixes, make it, in a commit of its own if you are committing, and say what you changed.
  - When the break is deliberate (a compaction, a history window the team chose), stop and show the user the message. If they confirm it, allow it in that step only: `session.assertStable({ allowBreakIn: { compaction: "compaction" } })` allows one break in the step named "compaction". Where the run has no steps, allow it at that call: `allowBreakAt: { 7: "compaction" }`, or `--allow-break-at 7=compaction` in case C. The number is the call's number in the failure message; calls are counted from 1.
  - Otherwise stop and show the user the message.
  - Leave the failing test in place, and say that it fails and why.

## 6. Make sure CI runs it

Check that the command CI already runs picks the new test up. When the project has no workflow that runs tests, say so and ask before adding one. In case C, CI also needs Node.js 22 or later, and `npx` downloads the package the first time it runs: tell the user, and change a workflow only when they agree.

## 7. Report

Start with what you found in step 1. Then say which case it was, the files you added or changed, the test's output with the summary table when the test has steps, any cache break you found with prefixlens's message for it and the size it gives, anything you are waiting for an answer on, and what the test does not cover: name each thing from step 1 that it leaves out, and why.

## Rules

- Send no real model requests and use no real API key.
- Ask before changing the project's own code. That covers any fix from step 5, and any change made only so that a test can reach the model provider. Show the change as a diff first, and keep it as small as it can be.
- Ask before adding a CI workflow, or making the tests need Node.js in case C.
- When there is nobody to ask, stop at that point and put the question in your report.
- Install exactly version {{version}}, and keep the lockfile change.
- Commit no trace files: a trace holds prompts.
- In your report, quote only the lines prefixlens names; don't paste full system prompts or anything that looks like a secret.
- Do not commit, push or open a pull request unless the user asks you to.
- More detail, when you need it: https://github.com/parthg1901/prefixlens/blob/main/docs/assertions.md
