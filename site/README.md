# The landing page

The page at https://prefixlens.parthg.dev: one static `index.html`, the instructions for a coding agent as
`agent.md`, and a real HTML report of the sample session.

```sh
npm run build                 # the package: the page is made with dist/cli.js
node site/build.mjs           # writes site/dist
npx serve site/dist           # or any static file server
```

| File | What |
|---|---|
| `src/index.html` | The page, with `{{placeholders}}` the build fills in. |
| `src/styles.css`, `src/app.js` | Inlined into the page. The script only copies text and switches the recipe tabs. |
| `src/agent.md` | The instructions the "Copy instructions for your agent" button copies. Served as `/agent.md` too. |
| `src/recipes/` | The code shown under "Or wire it yourself", and the output of the Mastra test. |
| `build.mjs` | Fills the page. The ledger, the terminal output and `report.html` come from running prefixlens on `test/fixtures/agent-session.jsonl`, so the page cannot drift from the tool. |

Rules for what the page says:

- It is for teams that build agent harnesses and frameworks. It names no coding agent.
- A recipe goes on the page only after it has been run. When a framework's API changes, run it again and update
  the versions named beside it.
- Change `src/agent.md` only together with a run of it by a coding agent on a real repository.

`test-node/site.test.mjs` builds the page and checks it. Deployment is Vercel, configured by `vercel.json` at the
repository's root; nothing here is part of the npm package.
