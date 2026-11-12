# Pricing

Prices live in [`pricing.json`](../pricing.json), not in code. The bundled table has the pay-as-you-go API list prices of Anthropic, OpenAI and Gemini text models, standard tier, as published on the providers' own pricing and model pages on the table's `as_of` date.

Its `sources` section lists every page used and when it was checked. Its `notes` say what is left out.

## Costs are list prices, not your bill

A report's costs are what the calls would cost billed per token at the table's prices.

- Calls made on a subscription are not billed per token at all. For them the numbers say what each miss would have cost on an API key, which is still the right scale for comparing misses.
- Negotiated discounts, Batch and Flex, OpenAI and Gemini priority tiers, data-residency uplifts and per-modality (audio) prices are not applied.
- Cloud ids (Bedrock, Google Cloud) are priced at the first-party list price. Those platforms set their own prices.

A trace records how a call was billed when its writer knows (`"billing"`: `"per_token"` or `"subscription"`), and a report words its cost lines accordingly. When no record says, the report notes that costs are list prices.

## The table

What an entry of `models` holds:

| field | meaning |
|---|---|
| `names` | Exact model ids: the provider's id, its documented aliases and dated snapshots. |
| `input`, `cache_read`, `output` | Prices per million tokens. Required. |
| `cache_write` | Write price for the default cache lifetime. |
| `cache_write_1h` | Anthropic's 1-hour write price, applied to `cache_write_1h_tokens`. |
| `cache_write_12h` | OpenAI's 12-hour write price, applied to `cache_write_12h_tokens`. Other writes are priced at `cache_write`. |
| `tiers` | Higher prices for the whole request when its prompt (uncached + read + written) is above `above_prompt_tokens`. |
| `from`, `until` | First and last UTC day a price applies, for promotions that end on a set date. Calls are priced by the day they were sent. |
| `when_params` | Request parameters that select the price. Anthropic fast mode is `{"speed": "fast"}`. |
| `cache_ttl_seconds`, `min_cacheable_tokens` | This model's cache lifetime and minimum cacheable prompt, overriding the provider's. |
| `unverified` | Fields the provider's pages do not print. Informational. |

Notes on some fields:

- **`cache_write`.** The default lifetime is 5 minutes on Anthropic and 30 minutes on OpenAI (GPT-5.6 and later). Earlier OpenAI models and Gemini charge no writes.
- **`tiers`.** In the bundled table: Claude Haiku 5.5 above 100,000 tokens, OpenAI above 272,000, Gemini Pro above 200,000.
- **`cache_ttl_seconds`, `min_cacheable_tokens`.** They decide when a miss is called expiry and when a prompt is too short to cache.
- **`unverified`.** For example `["cache_read"]` where a provider's page shows "-" for a model's cached input. The table then charges cached tokens at the input price.

Two more lists sit beside `models`:

- **`exclude`**: models left unpriced on purpose, each with a `reason`, such as the `-latest` aliases Google repoints at newer models. They get no price from the table or from models.dev, and the report gives the reason.
- **`families`**: cache facts by model-id prefix, for models no entry lists, such as ones priced from models.dev. Example: `{"provider": "openai", "prefixes": ["gpt-5.6", "gpt-6"], "cache_ttl_seconds": 1800}`.

For cache facts, an entry's own win, then the longest matching family, then the provider's.

## How a model is matched

The trace's model id and each name are compared after lowercasing and removing these parts:

- router and API prefixes (`openrouter/openai/`, `models/`);
- Bedrock region and vendor prefixes and version suffixes (`global.anthropic.`, `openai.`, `-v1:0`);
- the separators `@` (Google Cloud dates) and `.`, which are both read as `-`.

So `anthropic/claude-sonnet-4.5`, `claude-haiku-4-5@20251001` and `us.anthropic.claude-opus-4-1-20250805-v1:0` find their models.

Matching then works like this:

- An entry that lists the id wins. Among those, one whose `when_params` match the request beats one without.
- Nothing else matches. A family name (`gpt-6`), an effort suffix (`gpt-6-luna-high`) or a `-fast` suffix the provider does not document gets no price rather than a neighbour's. So does a hot-swapped alias (`gemini-flash-latest`), which the bundled table lists in `exclude`.
- Your own table may also use glob patterns in a `match` field. They are tried only when no entry lists the id exactly.
- Two entries that list the same id for overlapping days and the same parameters are an error.

A model with no price, or none on the day of the call, is reported with its token counts and the note `No price for <model>: add it to the pricing table to get costs.` The rest of the report is unchanged.

## Keeping it current

When the table is more than `stale_after_days` days old (60 in the bundled table) on the day you run a report, the report gives its age.

To update prices:

1. Edit `pricing.json`, or copy it and pass your copy with `--pricing <file>` or `PREFIXLENS_PRICING=<file>`.
2. Change the figures from the provider's pricing page.
3. Set `as_of` and the provider's `sources.<provider>.checked` to the day you checked.

`--pricing` wins over `PREFIXLENS_PRICING`, which wins over the bundled table. Whichever is used, the models.dev prices below fill in only the models it does not list.

## A second source: models.dev

[models.dev](https://models.dev) is a community-maintained catalogue of models and their prices across more than 200 providers, including routers and clouds that resell the same models under their own ids.

prefixlens can use it for models the table does not list, and to notice when the table has gone stale. Its data is © 2025 models.dev, published under the [MIT licence](https://github.com/anomalyco/models.dev/blob/dev/LICENSE); thanks to its contributors. The file prefixlens writes carries the licence notice.

### Commands

Nothing is fetched unless you ask:

```sh
prefixlens pricing update                     # fetch https://models.dev/api.json, convert it, save it
prefixlens pricing update --from api.json     # or convert a copy you saved (offline)
prefixlens pricing show claude-opus-5-5       # which price a model gets, from which source and date
prefixlens pricing check                      # where models.dev and the pricing table disagree (exit 1 if they do)
```

| option | applies to | meaning |
|---|---|---|
| `--from <file>` | `update`, `check` | Read a saved copy of `https://models.dev/api.json` instead of fetching it. |
| `--pricing <file>` | all | The table to compare with or look in. |
| `--provider <name>` | `show` | The trace provider. Inferred for `claude`, `gpt`, o-series and `gemini` ids. |
| `--date <YYYY-MM-DD>` | `show` | The day of the call (default: today). |
| `--catalogue-provider`, `--no-catalogue` | `show` | As for `report`. |
| `--json` | `check` | Print the comparison as JSON. |
| `--all` | `update`, `check` | List every change, not the first 20. |

`update` fetches with a 30-second timeout and a 32 MB limit (the catalogue is about 6 MB), and fails with a clear message when offline. It prints what changed since the previous fetch (models added and removed, prices changed) and every disagreement with the pricing table.

It saves only the converted prices, about 1 MB, to:

| platform | file |
|---|---|
| Linux and others | `$XDG_CACHE_HOME/prefixlens/models.dev.json`, else `~/.cache/prefixlens/models.dev.json` |
| macOS | `~/Library/Caches/prefixlens/models.dev.json` (or under `$XDG_CACHE_HOME` when set) |
| Windows | `%LOCALAPPDATA%\prefixlens\Cache\models.dev.json` |

Delete that file to stop using catalogue prices, or pass `--no-catalogue` to `report` or `pricing show`. The catalogue is not bundled with prefixlens: it changes daily and is mostly models no trace of yours will use.

`pricing check` is meant for maintainers and a scheduled CI job. It fetches the catalogue (or reads `--from`), compares every entry of the pricing table in effect today with models.dev's entry for the same provider and id, and exits 1 when any shared figure differs.

### Which price a call gets

1. **The pricing table wins for every model it lists**, with every field: cache-write lifetimes, tiers, cache lifetime, minimum cacheable size, dated prices. A model it lists only on other days or with other parameters stays unpriced on the other days. The catalogue does not fill the gap.
2. **For a model in both, the shared figures are compared**: input, cache read, the default-lifetime cache write, output, prompt-size tiers, and Anthropic fast mode. A difference becomes a report note naming both figures and both dates, and the table's price is used.
3. **Only for a model the table does not list does the catalogue price the call.** The report says so in a note that names the models.dev entry, its last-updated date and the fetch date.

For a catalogue-priced model, cache lifetime and minimum cacheable size come from the table's `families` when one matches the id, else from its provider defaults, since models.dev has neither. A catalogue-priced GPT-5.6 model keeps writes 30 minutes this way.

### Provider and model identity

A trace's `provider` names whose caching rules apply, not who billed the call. A call through a router to a Claude model is `anthropic`.

It maps to one models.dev provider: `anthropic` to `anthropic`, `openai` to `openai`, `gemini` to `google`, and any other id to the models.dev provider of the same id (`deepseek`, `openrouter`).

Within that one provider, the model id is matched:

1. exactly (lowercase, `.` and `@` read as `-`);
2. then without leading `segment/` prefixes (`openrouter/anthropic/claude-x` → `anthropic/claude-x` → `claude-x`);
3. then with the normalization the pricing table uses.

When that last step finds several entries with different prices, the call gets no price and the note names the candidates. This happens with a router's `vendor/model` ids or a cloud's regional ids (`us.anthropic.…` costs 10% more on Bedrock).

Another provider's price for a same-named model is never used, unless you opt in for models the table lacks:

```sh
prefixlens report run.trace.jsonl --catalogue-provider anthropic=openrouter,openai=openrouter
```

A model the table lists in `exclude` gets no catalogue price either.

### What models.dev does not have

models.dev has no 1-hour (Anthropic) or 12-hour (OpenAI) cache-write price, no cache lifetime or minimum cacheable size, no dates on which a promotional price ends, and no record of where a figure came from.

A catalogue price is used only when it lists every price the call needs. Otherwise the call is reported unpriced, with a note saying which price was missing, rather than priced at a guess:

- no cache-read price: no call of that model is costed, since a miss is costed against the cache-read price;
- no cache-write price: calls that wrote to the cache are not costed; calls that wrote nothing are;
- calls with 1-hour or 12-hour cache writes are not costed from the catalogue;
- a prompt-size tier that leaves out a price the base lists does not borrow the base's;
- a separate reasoning-token price: calls that report reasoning tokens are not costed;
- request parameters that select one of models.dev's per-mode prices (`speed: "fast"`) use that price, and a mode with no price leaves the call unpriced. OpenAI's `service_tier` modes are not applied, as in the bundled table.
