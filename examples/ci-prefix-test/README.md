# prefixlens in CI: an example

A toy request builder (`agent.ts`) with switches for the four bugs that most often break prompt caching, and a `bun test` suite (`prefix.test.ts`) that uses `prefixlens/test` to catch each one.

```sh
bun test
```

Here `prefixlens` resolves to this repository's source through `tsconfig.json` `paths`, so there is nothing to install. In your own project, add prefixlens as a dev dependency instead and drop the `paths` entry.

Uncomment the last test in `prefix.test.ts` to see a real failure message.
