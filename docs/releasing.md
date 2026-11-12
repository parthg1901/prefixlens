# Releasing prefixlens

Releases are published by `.github/workflows/release.yml` when a tag `v<version>` is pushed. The workflow checks that `package.json` is not private, that the tag is `v` + its `version` and that `CHANGELOG.md` has a section for that version (`scripts/release-check.mjs`, which you can run locally); runs the Bun suite and the Node suite on Node 22.0.0 and 26, with the packed-package check; builds; publishes to npm with trusted publishing and provenance; and creates a GitHub release whose notes are that changelog section.

While `package.json` has `"private": true`, the first job fails with a message saying so, and nothing is published.

## One-time setup

What npm's documentation says (docs.npmjs.com, "Trusted publishing for npm packages" and `npm trust`), checked 2026-11-12:

- Trusted publishing needs npm 11.5.1 or later and Node 22.14 or later on the runner (the workflow uses Node 24 and upgrades npm if it is older). Configuring it from the command line with `npm trust` needs npm 11.15.0 or later and two-factor authentication on your npm account.
- The package must already exist on the registry before a trusted publisher can be configured for it. The first version therefore has to be published once by hand, from your machine, with your own npm login.
- A new trusted-publisher configuration must complete a successful publish within 2 days, or it expires and has to be deleted and created again.
- `package.json`'s `repository.url` must match the GitHub repository exactly.
- Provenance is generated only for a public package published from a public repository. The workflow passes `--provenance`, so a publish from a private repository fails instead of going out without it.

Steps:

1. Fill in the release checklist below and remove `"private": true`.
2. Publish the first version by hand: `npm login`, then in a clean checkout of the tagged commit, `bun install --frozen-lockfile && npm publish --access public` (the `prepack` script builds `dist/`). Check the result with `npm view prefixlens`.
3. On npmjs.com, open the package's settings, and under "Trusted publishing" add a GitHub Actions publisher: the owner and repository, workflow file name `release.yml`, no environment (unless you add one to the workflow's `publish` job). Or from the command line: `npm trust github prefixlens --file release.yml --repo <owner>/<repo> --allow-publish`.
4. Within 2 days, publish the next version through the workflow (below), so the configuration is validated.
5. Then, as npm recommends, restrict token-based publishing in the package's settings ("Require two-factor authentication and disallow tokens"), so only the workflow can publish.
6. On GitHub, protect the `v*` tags (a tag ruleset) so only maintainers can push them.

## Releasing a version

1. Move the entries under `## [Unreleased]` in `CHANGELOG.md` into `## [<version>] - <YYYY-MM-DD>`, and add the compare link for it at the bottom.
2. Set `version` in `package.json` to the same version.
3. Run `bun run typecheck`, `bun test`, `npm run test:node`, `node scripts/check-package.mjs` and `node scripts/release-check.mjs v<version>`.
4. Commit, then `git tag v<version>` and `git push origin main v<version>`.
5. Watch the Release workflow. When it is done, check the version on npmjs.com (it shows the provenance) and the GitHub release.

A failed publish can be retried by re-running the workflow; npm refuses to publish the same version twice, so a version that did go out needs a new version number, not a re-tag.

## Release checklist (before the first release)

- [ ] `package.json`: add `repository` (`{ "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" }`), `homepage` and `bugs` (`{ "url": ".../issues" }`).
- [ ] `SECURITY.md`: the link to the repository's private security advisory form (`https://github.com/<owner>/<repo>/security/advisories/new`).
- [ ] `README.md`: replace the `<repository URL>` placeholder in the install instructions, and the install section itself once the package is on npm (`npm install --save-dev prefixlens`).
- [ ] `CHANGELOG.md`: compare links for each version (`[0.4.0]: https://github.com/<owner>/<repo>/compare/v0.3.0...v0.4.0`) and `[Unreleased]`, and the date of the version being released.
- [ ] `package.json`: remove `"private": true`.
- [ ] Check that nothing private ships: `node scripts/check-package.mjs` lists the tarball's size and file count and fails on tests, fixtures, traces, source maps or local paths in it.
