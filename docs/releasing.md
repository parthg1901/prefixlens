# Releasing prefixlens

Releases are published by `.github/workflows/release.yml` when a tag `v<version>` is pushed. The workflow:

1. checks that `package.json` is not private, that the tag is `v` + its `version`, that `CHANGELOG.md` has a section for that version and that nothing is left under `## [Unreleased]` (`scripts/release-check.mjs`, which you can run locally);
2. runs the Bun suite and the Node suite on Node 22.0.0 and 26, with the packed-package check;
3. builds, and publishes to npm with trusted publishing and provenance, unless that exact version is already on the registry;
4. creates a GitHub release whose notes are that changelog section.

While `package.json` has `"private": true`, the first job fails with a message saying so, and nothing is published.

Neither workflow has run yet: there is no repository on GitHub. Everything here about what they do is read from the workflow files, not observed.

## Pushing

Push the branch and one version tag by name, and nothing else:

```sh
git push origin main
git push origin v<version>
```

Never `git push --tags` and never `git push --mirror`. The clone this project was developed in has a local tag, `backup/pre-rewrite`, that holds an earlier copy of the history: the same commits under other hashes. `--tags` or `--mirror` would publish it as a second copy of the whole history, and a tag cannot be taken back once others have fetched it. If you would rather not depend on remembering this, delete the tag first (`git tag -d backup/pre-rewrite`).

The commits carry the author name and email address configured in git when they were made. Both become public, permanently, with the first push; changing them afterwards means rewriting history. Look at `git log --format='%an <%ae>' | sort -u` before the first push and decide whether that is what you want published.

## The first two releases: 0.5.0 by hand, 0.5.1 through the workflow

What npm's documentation says (docs.npmjs.com, "Trusted publishing for npm packages" and `npm trust`), checked 2026-11-12:

- Trusted publishing needs npm 11.5.1 or later and Node 22.14 or later on the runner (the workflow uses Node 24 and upgrades npm if it is older). Configuring it from the command line with `npm trust` needs npm 11.15.0 or later and two-factor authentication on your npm account.
- The package must already exist on the registry before a trusted publisher can be configured for it. The first version therefore has to be published once by hand, from your machine, with your own npm login.
- A new trusted-publisher configuration must complete a successful publish within 2 days, or it expires and has to be deleted and created again.
- `package.json`'s `repository.url` must match the GitHub repository exactly.
- Provenance is generated only for a public package published from a public repository. The workflow passes `--provenance`, so a publish from a private repository fails instead of going out without it.

So the first release takes two versions, and both should be planned before the first is published: **0.5.0** goes out by hand, and **0.5.1** follows through the workflow within npm's 2 days, to validate the trusted publisher. 0.5.1 needs a changelog section with at least one entry; the publish-time changes to the README and `SECURITY.md` in the checklist below are enough for one if nothing else has come up.

Steps:

1. Create the public repository on GitHub. Fill in the release checklist below, which ends with removing `"private": true`, and commit.
2. `git push origin main` (see "Pushing" above) and wait for CI. It has never run: this is the first time the suites run on macOS, on Node 22.0.0 and on Node 26. Fix what it finds before going on.
3. Run the local checks of "Releasing a version" step 3, with `v0.5.0`. Then `git tag v0.5.0`, and do not push the tag yet.
4. Publish 0.5.0 by hand: `npm login`, then in a clean checkout of the tagged commit, `bun install --frozen-lockfile && npm publish --access public` (the `prepack` script builds `dist/`). Check the result with `npm view prefixlens`. This one version has no provenance statement, since it was not published from the workflow.
5. `git push origin v0.5.0`. The Release workflow runs its checks and tests, finds 0.5.0 already on the registry, skips the publish, and creates the GitHub release from the changelog section. If the tag were pushed before step 4, the publish step would fail (no trusted publisher exists yet) and no GitHub release would be created; re-running the workflow after step 4 then creates it.
6. On npmjs.com, open the package's settings, and under "Trusted publishing" add a GitHub Actions publisher: the owner and repository, workflow file name `release.yml`, no environment (unless you add one to the workflow's `publish` job). Or from the command line: `npm trust github prefixlens --file release.yml --repo parthg1901/prefixlens --allow-publish`.
7. Within 2 days, release 0.5.1 through the workflow ("Releasing a version" below), so the configuration is validated. Check that its page on npmjs.com shows the provenance.
8. Then, as npm recommends, restrict token-based publishing in the package's settings ("Require two-factor authentication and disallow tokens"), so only the workflow can publish.
9. On GitHub, protect the `v*` tags (a tag ruleset) so only maintainers can push them.

## Releasing a version

1. In `CHANGELOG.md`, move the entries under `## [Unreleased]` into a new `## [<version>] - <YYYY-MM-DD>` section below it, leaving `## [Unreleased]` empty. At the bottom, add the link for the version and point `[Unreleased]` at it:

   ```
   [Unreleased]: https://github.com/parthg1901/prefixlens/compare/v<version>...HEAD
   [<version>]: https://github.com/parthg1901/prefixlens/compare/v<previous version>...v<version>
   ```

   Only versions that have a tag get a link. The first tag is `v0.5.0`, so its link is to the release (`releases/tag/v0.5.0`), and the first compare link is 0.5.1's (`compare/v0.5.0...v0.5.1`). The stages under "Before the first release" (0.1.0 to 0.4.0) were never tagged and have no links.
2. Set `version` in `package.json` to the same version.
3. Run `bun run typecheck`, `bun test`, `npm run test:node`, `node scripts/check-package.mjs` and `node scripts/release-check.mjs v<version>`.
4. Commit, then `git tag v<version>`, `git push origin main` and `git push origin v<version>` (never `--tags`; see "Pushing").
5. Watch the Release workflow. When it is done, check the version on npmjs.com (it shows the provenance) and the GitHub release.

A failed run can be re-run. If the publish had already gone through, the re-run skips it and creates the GitHub release. npm refuses to publish the same version twice, so a version that went out with a mistake in it needs a new version number, not a re-tag.

## Release checklist (before the first release)

Each line is something that is true or unfilled today, while there is no public repository and no published package, and has to change when there is one. The wording to change to is given where it is not obvious.

Addresses, once the repository address is known:

- [x] `package.json`: add `repository` (`{ "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" }`), `homepage` and `bugs` (`{ "url": ".../issues" }`).
- [x] `CHANGELOG.md`: replace `<owner>/<repo>` in the two link definitions at the bottom (`[Unreleased]` and `[0.5.0]`).
- [x] `SECURITY.md`, "Reporting a vulnerability": add the link to the repository's private security advisory form (`https://github.com/<owner>/<repo>/security/advisories/new`).
- [x] `README.md`, "Install": replace the `<repository URL>` placeholder in the clone command.
- [x] `docs/releasing.md` (this file): replace `<owner>/<repo>` in the `npm trust` command and in the link examples.

Sentences that stop being true:

- [ ] `README.md`, "Status", first paragraph ("prefixlens 0.5 is unreleased. … it has not run yet: there is no public repository. So Node support has been tested on Linux only, with Node 24 only, and nothing has been run on macOS."). After the first green CI run, change it to: "prefixlens 0.5 is the first release. The checks on real traffic below were all made on one machine, Linux arm64, with Bun 1.4.0 and Node 24.20. CI runs the Bun suite on Linux and macOS and the Node suite on Node 22.0.0 (the minimum) and 26, on Linux and macOS." Do not write this before CI has passed on every one of those.
- [ ] `README.md`, "Status", last "Not checked" item ("the release workflow, which cannot run before there is a repository and an npm package."). With 0.5.0: "the release workflow's publish step, which runs for the first time for 0.5.1." Remove the item once 0.5.1 has gone out through the workflow.
- [ ] `README.md`, "Install", first sentence ("prefixlens is not on a package registry yet; use it from a clone, or pack the clone and install the tarball."). Change to: "Install it from npm: `npm install --save-dev prefixlens` (or `bun add -d prefixlens`), then `npx prefixlens --help`." and keep the clone instructions below it under "From a clone". The sentence "Run `bun src/cli.ts` wherever this README says `prefixlens`" then applies to a clone only.
- [ ] `SECURITY.md`, "Reporting a vulnerability" ("prefixlens has not had a first release yet; until it does, only the latest commit is supported."). Change to: "Only the latest released version is supported."
- [ ] `CHANGELOG.md`, third paragraph ("No version has been published to a package registry yet. 0.5.0 is to be the first. …"). Change to: "0.5.0 is the first published version. The entries under "Before the first release" record development stages that were never published."
- [ ] `CHANGELOG.md`: set the date in `## [0.5.0] - 2026-11-12` to the day it is published.
- [ ] `docs/releasing.md` (this file): remove "Neither workflow has run yet" at the top once both have.

Before the tag:

- [x] `.github/workflows/ci.yml` and `release.yml`: pin each action to a full commit hash instead of a major tag (`actions/checkout@v4`, `actions/setup-node@v4`, `oven-sh/setup-bun@v2`), with the version in a comment beside it. It matters most in the `publish` job of `release.yml`, which holds `id-token: write`. Look the hashes up on each action's releases page; do not copy them from anywhere else.
- [ ] Decide whether the author name and email in the commits are what you want public ("Pushing" above).
- [ ] Check that nothing private ships: `node scripts/check-package.mjs` lists the tarball's size and file count and fails on tests, fixtures, traces, source maps or local paths in it.
- [ ] `package.json`: remove `"private": true`. Do this last: it is the one thing that stops a tag from publishing.
- [ ] Push with `git push origin main` and `git push origin v0.5.0` only, never `--tags` ("Pushing" above).
