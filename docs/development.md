# Development

## From a clone

With Bun, the TypeScript sources run as they are:

```sh
git clone https://github.com/parthg1901/prefixlens.git && cd prefixlens
bun install              # dev dependencies only: TypeScript, Bun's types, and the two SDKs the tests wrap
bun src/cli.ts --help    # the CLI, run from the checkout
```

With Node, build first. `dist/` then holds the JavaScript and type declarations that ship:

```sh
bun install && bun run build    # or, without Bun: npm install --no-package-lock && npm run build
node dist/cli.js --help
```

To try a checkout in another project, pack it and install the tarball there:

```sh
npm pack                                                   # builds dist/ and writes prefixlens-<version>.tgz
cd ../your-project && npm install --save-dev ../prefixlens/prefixlens-*.tgz
```

## Checks

```sh
bun test                                    # unit, importer, CLI and privacy tests on Bun
bun run typecheck
bun run build                               # dist/: JavaScript and declarations, for Node and for the package
node --test "test-node/*.test.mjs"          # the built package on Node (npm run test:node builds first)
node scripts/check-package.mjs              # pack, install the tarball into temporary projects with npm and Bun, and use it there
cd examples/ci-prefix-test && bun test      # the CI example, which imports src/ through tsconfig paths
```

CI (`.github/workflows/ci.yml`) runs, on pushes to `main` and on pull requests:

- the Bun suite on Ubuntu and macOS;
- the Node suite and the package check on Node 22.0.0 and 26, on Ubuntu and macOS;
- a check that fails if a trace, session log or credential is committed.

## Runtimes

Node 22 is the minimum. Two features need a later Node and say so when it is missing: reading an opencode SQLite database (Node 22.13) and decoding zstd request bodies in the proxy (Node 22.15). Bun has both.

What differs between the runtimes is kept in `src/runtime/`:

- the proxy's HTTP server: `Bun.serve` or `node:http`. Each releases every byte of a response, the last included, before the record is built. `test/stream-order.test.ts` and `test-node/proxy.test.mjs` check this on each.
- read-only SQLite: `bun:sqlite` or `node:sqlite`.

Files, hashing and compression use `node:` modules, which both runtimes provide.

## Fixtures

Test fixtures are small, synthetic and hand-written. Never commit real session logs or traces: they contain secrets and private code.

## Releases

Releases are published from a `v<version>` tag by `.github/workflows/release.yml`, with npm trusted publishing and provenance. The steps are in [releasing.md](releasing.md).
