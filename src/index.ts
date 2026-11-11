// Library entry point: recording (wrap, createLens, startProxy), the trace
// model, canonicalizer, diff engine, analysis and reports. The CI assertions
// are in "prefixlens/test".

import { createLens, wrap } from "./lens.ts"

export { createLens, wrap }
export type { Lens, LensOptions, Observation } from "./lens.ts"
export { startProxy, UPSTREAMS } from "./proxy.ts"
export type { ProxyOptions } from "./proxy.ts"
export { LANE_HEADER, SESSION_HEADER } from "./record/recorder.ts"
export { apiFromBody, apiFromPath, readResponse, sseEvents, RECORDED_HEADERS } from "./record/exchange.ts"
export type { Api } from "./record/exchange.ts"

export { canonicalizeAnthropic, canonicalizeGemini, canonicalizeOpenAI, canonicalizeRequest, canonicalJson, hashContent, makeBlock, stripCacheControl } from "./canonical.ts"
export type { CanonicalRequest, Provider } from "./canonical.ts"
export { createTraceEncoder, openTraceWriter, parseTrace, serializeTrace, TRACE_VERSION } from "./trace.ts"
export type { Block, BlockKind, Fidelity, Hint, HintKind, ParseResult, TraceRecord, TraceWriter, Usage } from "./trace.ts"
export { normalizeUsage, promptTokens } from "./usage.ts"
export { CAUSE_GROUP, comparePrefix, firstDivergence, PARAMS_IGNORED } from "./diff.ts"
export type { Cause, CauseGroup, Comparable, PrefixChange, Region } from "./diff.ts"
export { analyze } from "./analyze.ts"
export type { Analysis, AnalyzeOptions, CauseInfo, Status, Summary, TurnResult } from "./analyze.ts"
export { costOf, findPrice, loadPricing, parsePricing } from "./pricing.ts"
export type { PricingTable, PriceEntry, Rates } from "./pricing.ts"
export { ADAPTERS, findAdapter } from "./adapters/index.ts"
export type { Adapter, ImportOptions, ImportResult } from "./adapters/index.ts"
export { renderHtml } from "./report/html.ts"
export { renderJson } from "./report/json.ts"
export { renderTerminal } from "./report/terminal.ts"

/** `import prefixlens from "prefixlens"; const client = prefixlens.wrap(new Anthropic())` */
export default { wrap, createLens }
