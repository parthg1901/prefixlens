# Add a prompt-cache regression test with prefixlens

This repository sends requests to an LLM API, directly or through a framework. Add a test that fails when a code change breaks the provider's prompt cache. Use prefixlens: the npm package `prefixlens`, at exactly version {{version}} (https://github.com/parthg1901/prefixlens).

Why it matters: a provider caches the start of a request. When anything early in the request differs from the previous call of the same conversation (the tool list or its order, the system prompt, an earlier message), everything after that point is billed at full price, and nothing reports it. prefixlens compares consecutive requests and names the first block that changed.

## 1. Find how requests are built

Read the code that builds or sends model requests, and decide which case this is:

- **Case A: the project builds the request body itself.** There is a function that returns the body for the Anthropic Messages, OpenAI Chat Completions or OpenAI Responses API.
- **Case B: a framework or an SDK builds it.** The Vercel AI SDK, Mastra, LangChain, or a provider's SDK called from an agent loop.
- **Case C: the project is not JavaScript or TypeScript.** The test helpers are JavaScript, so the project's own tests capture the request bodies and a small Node script checks them.

When A and B are both true, do case B on the main agent loop: it covers more.

## 2. Install

Add `prefixlens` as a dev dependency at exactly version {{version}}, with the package manager the project already uses (for example `npm install --save-dev --save-exact prefixlens@{{version}}`), and keep the lockfile change. It needs Node.js 22 or later, or Bun, and has no dependencies of its own. In case C the project has no JavaScript package manager: step 3 says where it goes.

## 3. Write the test

Use the project's own test runner and put the test beside its other tests. Build the agent the way production does: the real system prompt, tools, memory and history settings. A simplified copy protects nothing. Writing the test should not need a change to the project's own code.

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
session.assertStable()
```

Case C, request bodies captured by the project's own tests. This adds a small Node.js tool to a project that has none: tell the user what you are about to add (the two files below, and Node.js 22 in CI) and ask before adding it.

1. In the project's test runner, write a test that collects the JSON bodies of consecutive model requests of one conversation, in the order they are sent and exactly as they go to the provider. Either call the project's request builder for each step, as in case A, or run the agent against the fake provider or the HTTP mock its tests already use and capture each body, as in case B, for at least eight user turns.
2. Add the checker in a directory of its own, so that it stays apart from the project's code:

```
tools/prefixlens/package.json    { "private": true, "type": "module", "devDependencies": { "prefixlens": "{{version}}" } }
tools/prefixlens/check.mjs       import { readFileSync } from "node:fs"
                                 import { assertSessionStable } from "prefixlens/test"

                                 assertSessionStable(JSON.parse(readFileSync(process.argv[2], "utf8")))
```

3. Install it with `npm install --prefix tools/prefixlens`. Keep its `package-lock.json`, and keep `tools/prefixlens/node_modules` out of version control.
4. In the test, write the bodies to a temporary file as one JSON array, run `node tools/prefixlens/check.mjs <file>`, and fail the test when it exits with anything but 0, showing what it printed. That output is prefixlens's message.

When the tests cannot produce request bodies without a real provider, stop and tell the user. The other route records a real run through a local proxy (`npx prefixlens record`, then `npx prefixlens check` on the trace); it makes real model calls, so set it up only when the user asks for it.

## 4. Run it

- **It passes.** Go to step 5.
- **It fails.** The message names the call, the first changed block, a diff and a fix. That is a real cache break in this project, not a problem with the test. Do not loosen the test, shorten the run or change the agent's settings to make it pass.
  - When the fix looks small (a timestamp or an id in the system prompt, tools sent in an unstable order), show it to the user as a diff and ask before applying it. Keep what the model needs: fix a value once per session or send it in a new message, and delete it only when nothing uses it. When the user has already told you to apply fixes, make it, in a commit of its own if you are committing, and say what you changed.
  - When the break is deliberate (a compaction, a history window the team chose), stop and show the user the message. If they confirm it, allow it at that call only: `session.assertStable({ allowBreakAt: { 7: "compaction" } })`, or the same option as the second argument of `assertSessionStable` in case C. The number is the call's number in the failure message; calls are counted from 1.
  - Otherwise stop and show the user the message.
  - Leave the failing test in place, and say that it fails and why.

## 5. Make sure CI runs it

Check that the command CI already runs picks the new test up. When the project has no workflow that runs tests, say so and ask before adding one. In case C, CI also needs Node.js 22 or later and `npm ci --prefix tools/prefixlens` before the tests: tell the user, and change a workflow only when they agree.

## 6. Report

Say which case it was, the files you added or changed, the test's output, any cache break you found with prefixlens's message for it, anything you are waiting for an answer on, and what the test does not cover. Quote only the lines prefixlens names: do not paste a whole system prompt, or anything that looks like a secret.

## Rules

- Send no real model requests and use no real API key.
- Ask before changing the project's own code. That covers any fix from step 4, and any change made only so that a test can reach the model provider. Show the change as a diff first, and keep it as small as it can be.
- Ask before adding a CI workflow, or the `tools/prefixlens/` directory of case C.
- When there is nobody to ask, stop at that point and put the question in your report.
- Install exactly version {{version}}, and keep the lockfile change.
- Commit no trace files: a trace holds prompts.
- Do not commit, push or open a pull request unless the user asks you to.
- More detail, when you need it: https://github.com/parthg1901/prefixlens/blob/main/docs/assertions.md
