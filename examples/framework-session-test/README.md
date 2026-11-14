# prefixlens with a framework: an example

Four tests that use the test session of `prefixlens/test`. A session stands in for the model provider: it records every request a client sends, answers it with no network, and asserts that each request keeps the prefix of the one before it.

- `anthropic-messages.test.ts`, `openai-responses.test.ts` (streamed) and `openai-chat.test.ts`: one conversation in each request format.
- `tool-loop-compaction.test.ts`: a tool loop driven by `callTools`, with a compaction allowed at the one call where it happens.

```sh
bun test
```

The official SDKs stand in for a framework here. With the Vercel AI SDK, Mastra or LangChain, pass `session.fetch` to the model provider the same way (`createAnthropic({ fetch: session.fetch })`).

Here `prefixlens` resolves to this repository's source through `tsconfig.json` `paths`, so there is nothing to install. In your own project, add prefixlens as a dev dependency instead and drop the `paths` entry.
