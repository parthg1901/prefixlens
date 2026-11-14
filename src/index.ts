// Library entry point: recording (wrap, createLens, startProxy), the trace
// model, canonicalizer, diff engine, analysis and reports. The CI assertions
// are in "prefixlens/test".

import { createLens, wrap } from "./lens.ts"

export { createLens, wrap }
export type { Lens, LensOptions, Observation } from "./lens.ts"
export { startProxy, UPSTREAMS } from "./proxy.ts"
export type { ProxyOptions } from "./proxy.ts"
export { LANE_HEADER, SESSION_HEADER, SESSION_HEADERS } from "./record/recorder.ts"
export { apiFromBody, apiFromPath, buildRecord, readResponse, sseEvents, RECORDED_HEADERS } from "./record/exchange.ts"
export type { Api, ExchangeInput, RecordInput, ResponseSummary } from "./record/exchange.ts"

export { canonicalizeAnthropic, canonicalizeGemini, canonicalizeOpenAI, canonicalizeRequest, canonicalJson, hashContent, makeBlock, stripCacheControl } from "./canonical.ts"
export type { CanonicalRequest, Provider } from "./canonical.ts"
export { createTraceEncoder, openTraceWriter, parseTrace, serializeTrace, TRACE_FORMAT_VERSION, TRACE_VERSION } from "./trace.ts"
export type { Block, BlockKind, Fidelity, Hint, HintKind, ParseResult, TraceEncoderOptions, TraceLane, TraceRecord, TraceWriter, Usage } from "./trace.ts"
export { normalizeUsage, promptTokens } from "./usage.ts"
export { CAUSE_GROUP, comparePrefix, firstDivergence, PARAMS_IGNORED } from "./diff.ts"
export { PARAM_RULES, paramRule, UNKNOWN_PARAM } from "./params.ts"
export type { Evidence, InvalidatesFrom, ParamEffect, ParamRule } from "./params.ts"
export { BREAK_REASONS, changeStart, coveringBreaks, declaredBreaks, defaultAfter, keptBlocks } from "./breaks.ts"
export type { BreakReason, DeclaredBreak, Position } from "./breaks.ts"
export type { Cause, CauseGroup, Comparable, PrefixChange, Region } from "./diff.ts"
export { analyze } from "./analyze.ts"
export { classifyMisses, MISS_CLASSES } from "./check.ts"
export type { CallVerdict, Check, CheckOptions, MissClass } from "./check.ts"
export type { Analysis, AnalyzeOptions, CauseInfo, DeclaredBreakResult, ReasonTotal, Status, Summary, TurnResult } from "./analyze.ts"
export { costOf, findExclusion, findFamily, findPrice, loadPricing, normalizeModelId, parsePricing, providerFacts } from "./pricing.ts"
export type { Exclusion, Family, PricingTable, PriceEntry, ProviderFacts, Rates } from "./pricing.ts"
export {
  CATALOGUE_URL,
  catalogueDir,
  cataloguePath,
  catalogueProvider,
  catalogueRates,
  compareCatalogues,
  compareTables,
  convertCatalogue,
  fetchCatalogue,
  findCatalogueEntry,
  loadCatalogue,
  parseProviderMapping,
  readCatalogueFile,
  resolvePrice,
  writeCatalogue,
} from "./catalogue.ts"
export type { CatalogueEntry, CatalogueTable, PriceSources, Resolution } from "./catalogue.ts"
export { providerFamily } from "./provider.ts"
export { ADAPTERS, findAdapter } from "./adapters/index.ts"
export type { Adapter, ImportOptions, ImportResult } from "./adapters/index.ts"
export { renderCheck, renderCheckJson } from "./report/check.ts"
export { renderHtml } from "./report/html.ts"
export { renderJson } from "./report/json.ts"
export { renderTerminal } from "./report/terminal.ts"

/** `import prefixlens from "prefixlens"; const client = prefixlens.wrap(new Anthropic())` */
export default { wrap, createLens }
