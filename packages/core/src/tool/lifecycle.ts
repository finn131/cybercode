export * as LifecycleTools from "./lifecycle"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentGraph } from "../agent-graph/graph"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const finishInput = Schema.Struct({
  summary: Schema.String.annotate({ description: "What was accomplished, in a few sentences" }),
})
export type finishInput = typeof finishInput.Type

export const agentFinishedOutput = Schema.Struct({ agent_completed: Schema.Boolean, summary: Schema.String })
export type agentFinishedOutput = typeof agentFinishedOutput.Type

export const scanFinishedOutput = Schema.Struct({ scan_completed: Schema.Boolean, summary: Schema.String })
export type scanFinishedOutput = typeof scanFinishedOutput.Type

/**
 * Registered only when `agent_graph.enabled` is set. A model in an ordinary coding
 * session must not be able to end a run it was never scoped for.
 *
 * ponytail: no permission prompt here, matching Strix's auto-approve for autonomous
 * runs. Approval policy arrives with the mailbox phase; add `PermissionV2.assert`
 * to both tools if a run should ever require a human to sign off on completion.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const graph = yield* AgentGraph.Service
    const config = yield* Config.Service
    if (!Config.latest(yield* config.entries(), "agent_graph")?.enabled) return

    yield* tools
      .register({
        agent_finish: Tool.make({
          description:
            "Finish the task assigned to you and report the result. Call this exactly once when your task is done, including when it failed.",
          input: finishInput,
          output: agentFinishedOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.summary }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* graph.setStatus(context.sessionID, "completed")
              return { agent_completed: true, summary: input.summary }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "This session is not an agent-graph node" }))),
        }),
        scan_finish: Tool.make({
          description:
            "Finish the whole assessment and report the outcome. Call this exactly once when no further testing is worthwhile.",
          input: finishInput,
          output: scanFinishedOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.summary }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* graph.setStatus(context.sessionID, "completed")
              return { scan_completed: true, summary: input.summary }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "This session is not an agent-graph node" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/lifecycle",
  layer,
  deps: [ToolRegistry.node, AgentGraph.node, Config.node],
})