# The landing page

The page at https://prefixlens.parthg.dev: one static `index.html`, the instructions for a coding agent as
`agent.md`, and a real HTML report of the sample session.

**`site/public/` is the site, and it is committed.** The host serves that folder as it is; nothing is built at
deploy time. After a change to `site/src/`, or to what prefixlens prints, build it again and commit the result:

```sh
npm run build                 # the package: the page is made with dist/cli.js
node site/build.mjs           # writes site/public
npx serve site/public         # to look at it; any static file server will do
```

`test-node/site.test.mjs` fails while `site/public/` is not what the build gives, so a stale page is caught in the
pull request.

| File | What |
|---|---|
| `src/index.html` | The page, with `{{placeholders}}` the build fills in. |
| `src/styles.css`, `src/app.js` | Inlined into the page. The script only copies text and switches the recipe tabs. |
| `src/agent.md` | The instructions the "Copy instructions for your agent" button copies. Served as `/agent.md` too. |
| `src/llms.txt` | What prefixlens is and where its documents are, for a program that reads the site. Served as `/llms.txt`. |
| `src/404.html` | The page for an unknown address. With it the host answers 404; without it, the page with status 200. |
| `src/fonts/` | The two typefaces, one variable Latin file each, with their licences (SIL Open Font License). Served from the site, so the page waits on no other host. |
| `src/recipes/` | The code shown under "Or wire it yourself", and the output of the Mastra test. The output is shown without its `size:` line: the example conversation is a few messages long, and the cost of so small a break says nothing about a real one. |
| `src/og.png` | The link-preview image, 1200 by 630. To make it again: `node site/build.mjs --og <dir>` writes `og.html` there; screenshot it at 1200 by 630 in a headless browser and save the picture here. |
| `build.mjs` | Fills the page and writes `public/`, with `robots.txt`, `sitemap.xml` and the response headers. The ledger, the terminal output and `report.html` come from running prefixlens on `test/fixtures/agent-session.jsonl`. |
| `public/` | The built site, committed: what the host serves. Never edit it by hand. |

Rules for what the page says:

- It is for teams that build agent harnesses and frameworks. It names no coding agent.
- A recipe goes on the page only after it has been run. When a framework's API changes, run it again and update
  the versions named beside it.
- Change `src/agent.md` only together with a run of it by a coding agent on a real repository.

`test-node/site.test.mjs` also checks the page against the tool's output, the instructions and the recipe files.
Nothing here is part of the npm package.

## Deploying: Cloudflare Pages

Connect this repository to a Pages project and set:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | (leave empty) |
| Build output directory | `site/public` |
| Root directory | (leave empty) |
| Deploy command | (leave empty) |

No environment variable is needed. Then add the custom domain `prefixlens.parthg.dev` under the project's Custom
domains; with the domain's DNS on Cloudflare the record is made for you. `site/public/_headers` is applied by
Pages: two security headers, and `/agent.md` served as Markdown that any page may fetch.
