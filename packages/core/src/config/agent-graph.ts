export * as ConfigAgentGraph from "./agent-graph"

import { Schema } from "effect"

/**
 * Off by default: the lifecycle tools change what the model is allowed to end on,
 * which is only meaningful once a run is scoped to an authorized engagement.
 *
 * ponytail: `agent_graph` is silently dropped if the config file is detected as
 * V1 (has `agent`, `provider`, `tools`, `permission`, etc.) because `migrate()`
 * in `v1/config/migrate.ts` copies only known V1 keys. A warning fires at load
 * time when this happens.
 */
export class Info extends Schema.Class<Info>("ConfigV2.AgentGraph")({
  enabled: Schema.Boolean.pipe(Schema.optional),
}) {}