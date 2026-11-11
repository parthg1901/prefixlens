# prefixlens in CI: an example

A toy request builder (`agent.ts`) with switches for the four bugs that most often break prompt caching, and a `bun test` suite (`prefix.test.ts`) that uses `prefixlens/test` to catch each one. It also shows two changes that are fine: forbidding tool calls on the last step with `tool_choice: "none"` (OpenAI does not cache on it), and a revert declared with `allowBreak: "revert"`, which may drop messages but not change the tools or instructions.

```sh
bun test
```

Here `prefixlens` resolves to this repository's source through `tsconfig.json` `paths`, so there is nothing to install. In your own project, add prefixlens as a dev dependency instead and drop the `paths` entry.

Uncomment the last test in `prefix.test.ts` to see a real failure message.
