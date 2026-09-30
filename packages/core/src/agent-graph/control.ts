export * as AgentControl from "./control"

import { Effect } from "effect"
import { SessionExecution } from "../session/execution"
import { SessionSchema } from "../session/schema"
import { AgentGraph } from "./graph"
import { AgentHalt } from "./halt"

/**
 * Deliberately not a service: `SessionExecution` is an unbound global node, so a
 * Location-scoped layer cannot declare it as a dependency. Callers pass the
 * services they already hold, the same shape `AgentMessage.send` uses.
 */
export interface Deps {
  readonly halt: AgentHalt.Interface
  readonly graph: AgentGraph.Interface
  readonly execution: SessionExecution.Interface
}

/**
 * Halt the node, interrupt any in-flight turn, and keep it halted across drains.
 * The surviving halt is what suppresses the successor drain that an in-flight
 * wake can otherwise start after the interrupt.
 */
export function pause({ halt, graph, execution }: Deps, agentID: SessionSchema.ID) {
  return Effect.gen(function* () {
    yield* halt.request(agentID, "paused")
    yield* graph.setStatus(agentID, "budget_paused")
    // Interrupting is silent by design, and any tool that was in flight has
    // already been recorded as failed by the runner's own cleanup.
    yield* execution.interrupt(agentID)
  })
}

/** The only way out of a pause. */
export function resume({ halt, graph, execution }: Deps, agentID: SessionSchema.ID) {
  return Effect.gen(function* () {
    yield* halt.release(agentID)
    if (yield* graph.node(agentID)) yield* graph.setStatus(agentID, "running")
    yield* execution.resume(agentID)
  })
}

/**
 * Nodes that are waiting with no live drain in this process. Poll only: the
 * runner has no push edge for parking, so absence from `execution.active` is the
 * whole signal.
 */
export function parkedNodes({ graph, execution }: Pick<Deps, "graph" | "execution">) {
  return Effect.gen(function* () {
    const live = yield* execution.active
    return (yield* graph.nodes).filter((node) => node.status === "waiting" && !live.has(node.id)).map((node) => node.id)
  })
}