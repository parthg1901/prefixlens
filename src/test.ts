// "prefixlens/test": prefix-stability assertions for a harness's or a framework's own tests.
//
// `assertPrefixStable(prev, next)` compares two requests you built. `recordRequests()` gives a
// fetch that stands in for the model provider, records every request a framework sends, and
// asserts on all of them at once. Nothing here touches the network.

export { assertPrefixStable, explainPrefixDiff, PrefixBreakError } from "./assert.ts"
export type { ChangedBlock, Position, PrefixExplanation, PrefixOptions, RequestLike } from "./assert.ts"
export { assertSessionStable, callTools, recordRequests } from "./session.ts"
export type { AllowedBreak, CallExplanation, RecordedRequest, Reply, ReplyScript, RequestFormat, RequestSession, SessionOptions, StabilityOptions, ToolCall } from "./session.ts"
