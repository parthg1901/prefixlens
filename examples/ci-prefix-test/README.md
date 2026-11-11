# prefixlens in CI: an example

A toy request builder (`agent.ts`) with switches for the four bugs that most often break prompt caching, and a `bun test` suite (`prefix.test.ts`) that uses `prefixlens/test` to catch each one.

```sh
bun install   # installs prefixlens from ../.. (re-run after changing prefixlens)
bun test
```

Uncomment the last test in `prefix.test.ts` to see a real failure message.
