export * as ConfigAgentGraph from "./agent-graph"

import { Schema } from "effect"

/**
 * Off by default: the lifecycle tools change what the model is allowed to end on,
 * which is only meaningful once a run is scoped to an authorized engagement.
 */
export class Info extends Schema.Class<Info>("ConfigV2.AgentGraph")({
  enabled: Schema.Boolean.pipe(Schema.optional),
}) {}