# Reports

`prefixlens report <trace.jsonl>` reads a trace and prints, for every model call, how much of the cache it read, what it cost, and, for a miss, the first part of the request that changed.

```sh
prefixlens report session.trace.jsonl            # terminal
prefixlens report session.trace.jsonl --json     # machine-readable
prefixlens report session.trace.jsonl --html     # writes session.trace.html, one self-contained file
prefixlens import otel spans.json | prefixlens report -    # "-" reads the trace from stdin
```

For a pass or a fail in CI, `prefixlens check <trace.jsonl>` reads the same analysis and exits 1 when the harness broke its own cache: see [check.md](check.md).

## The terminal report

```
prefixlens report: agent-session.jsonl
5 model calls · 1 lane · 5 full-request, 0 usage-only

turn  time (UTC)  model            prompt   read  write  uncached  out    hit   cost  status
   1  10:00:02    claude-opus-5-5   48.2k      0  48.2k        12  140     0%  $0.24  cold
   2  10:00:09    claude-opus-5-5   48.6k  48.2k    420        12   95  99.1%  $0.01  hit
   3  10:00:17    claude-opus-5-5   49.0k  48.6k    380        12  110  99.2%  $0.01  hit
   4  10:00:26    claude-opus-5-5   49.9k      0  49.9k        12  160     0%  $0.25  miss: tool list changed (+1 tool: 3 → 4)
   5  10:00:34    claude-opus-5-5   50.3k  49.9k    350        12   60  99.3%  $0.01  hit

Misses
  turn 4: miss, tool list changed (+1 tool: 3 → 4), ~$0.24
    lost 49,000 of 49,000 cached tokens · vs turn 3 · confirmed
    + web_search

Totals
  prompt tokens   246,030  (read 146,720 · written 99,250 · uncached 60)
  output tokens   565
  cache hit rate  59.6% of prompt tokens read from cache
  cost            $0.54 at API list prices · $0.50 on uncached input and cache writes · $0.24 lost to misses
  calls           1 cold · 3 hit · 0 partial · 1 miss
  misses by cause
    tool-list changes                1  $0.24

1 miss cost $0.24 at list prices; 1 from tool-list changes
```

This is the report of [`test/fixtures/agent-session.jsonl`](../test/fixtures/agent-session.jsonl), a synthetic trace of an agent with three tools that gains a fourth before its fourth call. A trace with more than one lane has a `lane` column.

Notes follow the headline: how costs are priced, where the prices came from, and which calls are usage-only.

Long sessions hide the hit rows in the terminal; `--all` shows them. The HTML report always has every row, a chart of prompt tokens per call, and the diff for each miss.

## Options

| option | meaning |
|---|---|
| `--json` | Print the full analysis as JSON. See [The JSON report](#the-json-report). |
| `--html [file]` | Write a self-contained HTML report (default `<trace>.html`). It makes no external requests. |
| `--pricing <file>` | Use another pricing table (also `PREFIXLENS_PRICING`). See [pricing.md](pricing.md). |
| `--no-catalogue` | Do not use the models.dev prices that `prefixlens pricing update` fetched. |
| `--catalogue-provider <trace>=<models.dev>[,...]` | Price a trace provider's models that the table lacks from another models.dev provider, e.g. `anthropic=openrouter`. |
| `--tolerance <tokens>` | Lost tokens still counted as a hit (default 128). See [Cache steps](#cache-steps). |
| `--all` | Show every row and every miss in the terminal. |
| `--no-color` | Plain output. Also applies when `NO_COLOR` is set or output is not a terminal. |

## The JSON report

`report --json` prints one JSON object.

Its fields are not a stable interface yet. Until 1.0 a minor version may add, rename or remove them; such changes are listed in the [changelog](../CHANGELOG.md).

| field | holds |
|---|---|
| `report` | Always `"prefixlens"`. |
| `trace` | The trace path as given on the command line (`"-"` for stdin). |
| `pricing` | Where the prices came from: `source`, `as_of` when the table has one, and `catalogue` (`source`, `fetched_at`) when a models.dev file was loaded. |
| `version` | `1`. It is not raised when fields are added, so do not use it to detect a change before 1.0. |
| `summary` | Totals for the trace. |
| `turns` | One object per model call, in trace order. |
| `warnings` | What the trace reader and the analysis warned about. |

`summary` holds the calls, lanes, tokens, hit rate, cost, calls by status, misses by cause group, intentional breaks, the headline and the notes.

Each entry of `turns` holds the call's usage, hit rate, cost, expected and lost cached tokens and status. A miss also has a `cause`, with `summary`, `confidence`, `detail`, a `diff` excerpt and, for a changed block, its `block_index` and `block_label` (`tool "web_search"`, `message #3 (assistant)`).

A change that is not the cause of lost tokens is in `prefix_change`. `prefix_change_excused` says why the harness does not have to answer for it, when it does not: `declared` (a declared break allows it), `after_breakpoint` (it lies after the previous call's last cache breakpoint) or `new_conversation` (the two requests share no message).

Strings are the trace's content as it was, except the `diff` excerpts, in which control characters are written visibly (`\x1b`).

## Fidelity and confidence

A trace record is either **full-request** (it holds the request as ordered, hashed blocks) or **usage-only** (it holds the usage counts and what the harness logged about the call).

A report says when a trace is usage-only. Its hit rates and costs are exact, but a root-cause diff needs full requests.

Each miss is labelled with how its cause is known:

- **confirmed**: proven from two full requests.
- **inferred**: from timing, a model change or the harness's own log. Also a miss with the recorded prefix intact when a block of the request could not be recorded.
- **unknown**: the trace does not hold enough to name a cause. It is reported as *cause unknown* rather than guessed.

## Why caches miss

Prompt caching is a prefix match. The provider caches the request up to a point, and the next request reuses that cache only if it starts with exactly the same tokens. Anthropic renders a request as tools, then system prompt, then messages, so a change anywhere invalidates everything after it.

Most misses come from the harness rewriting its own prefix:

- **The tool list changed.** A mode switch trims 47 tools to 42, or an MCP server reconnects. Tools come first, so this invalidates everything.
- **The tool order changed.** The same tools, sorted by whichever MCP server connected first.
- **History was rewritten after the fact.** Old tool outputs truncated or expanded on replay, reasoning blocks dropped, a reminder appended to an old message, a recalled message inserted before one already sent, a relative date ("today", "2 hours ago") rendered again.
- **The history window slid.** The oldest messages are dropped on every call so the last N stay, and everything after them is re-read each time. Reported as *N oldest messages removed from the start of history*.
- **Steps were reshaped on replay.** Consecutive tool calls merged into one message, or one split into two.
- **Instructions were refreshed mid-session.** The system prompt rebuilt with a new timestamp, a re-read instructions file, or a changed environment block.
- **Compaction.** History replaced by a summary, with or without a tail of recent messages kept word for word. Expected, but each one costs a full re-write.
- **Model or parameter changes.** Caches are per model. Which parameters count depends on the provider: see [Which request parameters count](#which-request-parameters-count).
- **Expiry and provider-side misses.** The prefix is intact, but more time passed than the cache lifetime (5 minutes by default on Anthropic, 1 hour if requested), or the provider evicted the entry or routed the request elsewhere.

Two details of how these are counted:

- A compaction's loss is counted on the new, shorter prompt, since a call cannot pay for more tokens than it sent. The report also says how large the cache was that the compaction gave up.
- A call that read nothing after the cache lifetime had passed is an expiry even when the prefix also changed. It would have missed anyway, and the change is named beside it.

### Cache breakpoints

Breakpoints count where a provider caches only up to them: Anthropic's `cache_control`, and OpenAI's `prompt_cache_breakpoint` in explicit-only mode (`prompt_cache_options.mode: "explicit"`, GPT-5.6 and later).

Both are recorded as `breakpoint` on the block and left out of its hash, so a breakpoint that moves is not an edit. A change after the previous call's last breakpoint is not blamed for a miss.

## How verdicts are decided

Each call is compared with the previous call in the same lane. Subagents get their own lane.

1. **Expected cached tokens**: what the previous call left in the cache.
   - Anthropic: what it read plus what it wrote.
   - OpenAI and Gemini: its whole prompt, in whole [cache steps](#cache-steps), once it is long enough to cache.
2. **Lost tokens**: expected minus what this call read. More than 128 lost is a partial miss. Almost nothing read is a miss.
3. **Miss cost**: lost tokens × (the price paid for them − the cache-read price).
4. **Cause**:
   - when the call read nothing and was sent later than the cache lifetime after the previous one: expiry;
   - otherwise the first changed block in prefix order;
   - with the prefix intact: expiry or a provider-side miss, by the time since the previous call.

When a block of the request could not be recorded (the trace marks it `unknown`), a miss with everything else intact is worded as *a provider-side miss, or a change in the block the trace does not record*, and labelled inferred.

The first call in a lane has nothing to be compared with. It is `cold` when it read nothing. It is a hit, shown as `hit (warm start)`, when it read from a cache that something outside the lane had left, such as an earlier session with the same tools and instructions.

The exact rules are in [SPEC.md section 8](../SPEC.md#8-how-prefixlens-analyzes-a-trace-informative).

### Cache steps

OpenAI and Gemini read their implicit caches in whole steps. The step is 128 tokens unless the trace shows another.

The step is learnt per provider and model: it is the greatest common divisor of the non-zero cache reads in the trace, from at least four reads, and never below 128. A gateway can read in other steps than the provider behind it, 1,088 tokens for example. A report says when it used a learnt step.

With a learnt step, a request that exactly extends the previous one is still a hit when it is less than one step short. A whole step short is a miss.

### Which request parameters count

A parameter change explains a miss only if the provider caches on it. prefixlens keeps a table per provider: `PARAM_RULES` in code, [SPEC.md section 8.1](../SPEC.md#81-which-request-parameters-are-part-of-the-cached-prefix).

Each entry says how it is known: **verified** (measured on the live API), **documented** (the provider's caching documentation) or **assumed**.

Anthropic:

- documented: `tool_choice` (invalidates cached messages only), `thinking`, `output_config.effort` and `speed` count;
- assumed: `context_management` and `mcp_servers` count; sampling parameters and output limits do not.

OpenAI:

- verified: `tool_choice` does not count on the Responses API;
- documented: `reasoning`, `text`, `parallel_tool_calls`, `context_management` and `prompt_cache_key` count;
- assumed: `tool_choice` does not count on Chat Completions; the Chat Completions names `reasoning_effort`, `verbosity` and `response_format` count; sampling parameters, limits, `store`, `include`, `prompt_cache_options` and `prompt_cache_retention` do not.

Gemini:

- assumed: everything but sampling parameters and limits counts.

Any parameter not in the table is assumed to count, so a change is never silently ignored. In a test, `ignoreParams` leaves out one you have shown your provider does not cache on ([assertions.md](assertions.md#options)).
