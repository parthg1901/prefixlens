# Declaring intentional breaks

Some prefix breaks are deliberate: the harness compacts history and rebuilds its instructions, the user reverts to an earlier point, a refused exchange is left out of history, the user picks another model or reasoning effort.

A harness declares such a break so that it is reported as an intentional break, with its cost shown and totalled apart from the misses that point at bugs.

## In a trace

Declare the break on the first call after it, as a hint in the trace record:

```json
"hints": [{ "kind": "prefix_break", "reason": "revert", "detail": "reverted to message 12" }]
```

| reason | for | may change |
|---|---|---|
| `compaction` | History summarized or replaced, instructions possibly rebuilt | Anything |
| `revert` | Conversation rewound to an earlier point | Messages only: the tools and system prompt must stay |
| `refusal` | A refused exchange left out of history | Messages only |
| `model_switch` | Another model | Anything |
| `settings_change` | A parameter changed on purpose, e.g. reasoning effort | Anything |

Any other reason is allowed and may change anything.

`after` overrides how far a break may reach. It names the last part that must stay: `"start"`, `"tools"`, `"system"`, `{"system": n}` (the tools and the first n system parts), `{"message": n}` or a block count.

The older `compaction` and `model_switch` hints still declare a break. `agent_switch` and `tool_output_pruned` do not: a mode switch that changes the tool list is exactly the kind of change prefixlens should catch.

## In a test

`assertPrefixStable(prev, next, { allowBreak: "revert" })` allows exactly what a `revert` declaration excuses in a report. `allowBreak: { after, reason }` takes the same positions. See [assertions.md](assertions.md#allowbreak).

## What a declaration does not do

A declaration is not a way to make misses disappear.

- It excuses the miss of the call it is on and nothing else. A second miss right after it is a miss.
- It excuses only a change where its reason allows. A declared revert that also changed the tool list is reported as a miss, with the reason.
- It never excuses a miss with the prefix intact (expiry, provider-side).
- It never excuses a call that read nothing after the cache lifetime had passed. The cache was gone whatever the harness did, so that miss is an expiry, with the declared break named beside it.
- The report shows each intentional break with what changed and what it cost, and totals that cost separately. `summary.misses` and the miss cost count only the rest.

In `--json`, the intentional breaks are in `summary.intentional` and their cost in `summary.cost.intentional`.

## In a report

```
   4  10:01:20    gpt-4.1   2,000      0      -     2,000   40     0%  $0.0043  intentional break (compaction): system prompt changed (part 1 of 1 edited)
   7  10:02:20    gpt-4.1   2,500      0      -     2,500   40     0%  $0.0053  intentional break (revert): conversation rewound at message #3: …
   8  10:02:40    gpt-4.1   2,900      0      -     2,900   40     0%  $0.0061  miss: system prompt changed (part 1 of 1 edited)

1 miss cost $0.0036 at list prices; 1 from system-prompt changes. Also 2 intentional breaks declared by the harness cost $0.0067 at list prices (1 revert, 1 compaction).
```

The rules are in [SPEC.md section 6.1](../SPEC.md#61-declaring-an-intentional-break).
