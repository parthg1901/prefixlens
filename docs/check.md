# The CI check

`prefixlens check <trace.jsonl>` turns a recorded trace into a pass or a fail. It exits 1 when a call lost cached tokens for a reason your harness controls, or changed its prefix without declaring it, and prints only those calls.

```sh
prefixlens check run.trace.jsonl                 # a trace from the proxy, wrap, lens.fetch or an importer
prefixlens check run.trace.jsonl --json          # the verdict for every call
prefixlens import otel spans.json | prefixlens check -    # "-" reads the trace from stdin
```

For a failing trace it prints:

```
prefixlens check: run.trace.jsonl
FAIL: 1 of 5 calls

  turn 4: avoidable miss [tools_changed], tool list changed (+1 tool: 3 → 4)
    lost 49,000 of 49,000 cached tokens (~$0.24) · vs turn 3
    changed block: 4 (system part 1, now tool "web_search")
    + web_search
    fix: keep one tool list for the whole session (refuse a disallowed tool when it is called rather than removing it), or change it only at a deliberate breakpoint such as a compaction.

5 calls: 1 avoidable miss, 1 cold start, 3 ok
```

Each failing call is shown with its class, its cause in brackets, what happened, the tokens and list-price cost it lost, the first changed block, a diff of it and the fix. Turn numbers are the call's position in the trace, as in `prefixlens report`.

A passing trace prints one line and the counts:

```
prefixlens check: run.trace.jsonl
ok: no call lost cached tokens for a reason the harness controls, and no prefix change is undeclared

5 calls: 1 cache expiry, 1 cold start, 3 ok
```

## Exit codes

| code | meaning |
|---|---|
| 0 | No call is in a failing class. |
| 1 | At least one call is. They are printed. |
| 2 | The check could not be made: the trace is missing, empty or not a trace, or an option is wrong. |

## Classes

Every call gets exactly one class. The check adds no analysis of its own: a class follows from what [the report](report.md#how-verdicts-are-decided) finds about the call.

| class | the call | by default |
|---|---|---|
| `avoidable` | lost cached tokens because the tool list, system prompt, history, model or a cache-relevant parameter changed, and no declaration allows it | fails |
| `undeclared-change` | lost no cached tokens, but its request does not extend the previous one in its lane, and no declaration allows that | fails |
| `unexplained` | lost cached tokens, and the trace cannot say why: the record is usage-only and nothing the harness logged explains it | passes |
| `intentional` | lost cached tokens to a break the harness [declared](intentional-breaks.md), or to a cause named with `--allow` | passes |
| `expiry` | had its prefix intact, and was sent after the cache lifetime | passes |
| `provider-side` | had its prefix intact and in time: the provider evicted the entry or routed the request elsewhere | passes |
| `cold-start` | is the first in its lane and read nothing | passes |
| `warm-start` | is the first in its lane and read a cache left from outside the lane | passes |
| `ok` | is any other call | passes |

An `undeclared-change` is a break waiting for a cache to hit. It is found when nothing was cached yet (a short prompt, or caching not turned on), when the loss is within the tolerance, and when the cache had expired anyway. Three changes are not counted:

- one a `prefix_break` hint on the call allows;
- one after the previous call's last cache breakpoint, in a part the provider never cached;
- a request that shares no message with the previous one in its lane: that is another conversation with the same tools and system prompt, not a rewritten one.

## Options

| option | meaning |
|---|---|
| `--fail-on <classes>` | Classes that fail as well, comma-separated: `unexplained`, `intentional`, `expiry`, `provider-side`, `cold-start`, `warm-start`. `avoidable` and `undeclared-change` always fail. |
| `--allow <causes>` | Causes that are intentional in this trace, comma-separated, e.g. `compaction`. A call they explain is `intentional`. |
| `--json` | Print the verdict for every call, and the counts, as JSON. |
| `--pricing`, `--no-catalogue`, `--catalogue-provider`, `--tolerance` | As for [`report`](report.md#options). |

`--fail-on expiry,provider-side` is for a run that should never wait longer than the cache lifetime and expects every read to land.

`--allow` is for a trace whose writer cannot declare breaks. The proxy records requests, not intentions, so a compaction your scripted run performs on purpose is an avoidable miss until you allow it: `--allow compaction`. A cause is the name in brackets on a failing call (`tools_changed`, `system_dynamic_value`, `history_rewound`, …). A harness that writes its own trace should declare the break on the call instead, which allows that call only.

## `--json`

```json
{
  "check": "prefixlens",
  "trace": "run.trace.jsonl",
  "ok": false,
  "fail_on": ["avoidable", "undeclared-change"],
  "counts": { "avoidable": 1, "undeclared-change": 0, "unexplained": 0, "intentional": 0, "expiry": 0, "provider-side": 0, "cold-start": 1, "warm-start": 0, "ok": 3 },
  "calls": [
    { "turn": 1, "lane": "main", "class": "cold-start", "fails": false, "summary": "first call in its lane: nothing cached yet", "lost_tokens": 0, "expected_cached_tokens": 0, "miss_cost": 0 },
    { "turn": 4, "lane": "main", "class": "avoidable", "fails": true, "summary": "tool list changed (+1 tool: 3 → 4)", "cause": "tools_changed", "block": "4 (system part 1, now tool \"web_search\")", "diff": "+ web_search", "fix": "keep one tool list …", "lost_tokens": 49000, "expected_cached_tokens": 49000, "miss_cost": 0.24, "baseline_turn": 3 }
  ]
}
```

`calls` has one entry per call, in trace order (two are shown). `session` is present when the trace names one, `cause`, `block`, `diff` and `fix` when the call has them, and `baseline_turn` for every call but the first of its lane. Like the JSON report, these fields may change in a minor version before 1.0. The exit code is the same with and without `--json`.

## From code

`classifyMisses` gives the same answer to a program:

```ts
import { analyze, classifyMisses, loadPricing, parseTrace } from "prefixlens"

const analysis = analyze(parseTrace(traceText).records, { pricing: await loadPricing() })
const check = classifyMisses(analysis, { failOn: ["expiry"], allow: ["compaction"] })
if (!check.ok) for (const call of check.calls.filter((call) => call.fails)) console.error(`turn ${call.turn}: ${call.class}, ${call.summary}`)
```

It returns `{ ok, fail_on, counts, calls }`, the object `--json` prints. `renderCheck(check)` is the text above.

## In a test

A [test session](assertions.md#a-whole-run-recordrequests) needs no trace and no proxy: `session.assertStable()` fails the test itself. `session.writeTrace(file)` writes the session as a trace, which `prefixlens check` passes or fails the same way.
