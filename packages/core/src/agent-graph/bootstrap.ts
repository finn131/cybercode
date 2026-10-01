export * as AgentBootstrap from "./bootstrap"

import { Effect } from "effect"
import { AgentGraph } from "./graph"
import { Config } from "../config"

export interface PromptInput {
  readonly sessionID: AgentGraph.ID
  readonly parentID?: AgentGraph.ID
  readonly agent: string
  readonly task?: string
  readonly skills?: ReadonlyArray<string>
}

/**
 * Register a session as a graph node the first time it is prompted, using the
 * same `Location` service instance the drain will later use. Called from the V2
 * prompt handler rather than inside `SessionV2.prompt`, because the service is
 * Location-scoped while `SessionV2` is also built at instance scope in some wiring.
 *
 * ponytail: a V1-created node has no lifecycle tools at all, so the graph can hold
 * two flavours of "finished". That split is deliberate until the task tool moves
 * to V2; do not paper over it here.
 */
export function registerForPrompt(
  { graph, config }: { graph: AgentGraph.Interface; config: Config.Interface },
  input: PromptInput,
) {
  return Effect.gen(function* () {
    if (!Config.latest(yield* config.entries(), "agent_graph")?.enabled) return
    // Idempotent: the same session can be prompted many times.
    if (yield* graph.node(input.sessionID)) return

    yield* graph
      .register({
        id: input.sessionID,
        name: input.agent,
        parentID: input.parentID,
        task: input.task,
        skills: input.skills,
      })
      .pipe(
        Effect.catch((error) => {
          if (error instanceof AgentGraph.DuplicateAgentError) return Effect.void
          // Parent never registered: different Location, or the gate was off when
          // it was created. Fall back to a root so the child still runs.
          return Effect.logWarning("agent-graph: parent not registered, treating as root", {
            agentID: input.sessionID,
            parentID: input.parentID,
          }).pipe(
            Effect.andThen(graph.register({ id: input.sessionID, name: input.agent, task: input.task, skills: input.skills })),
            Effect.orDie,
          )
        }),
      )
  })
}