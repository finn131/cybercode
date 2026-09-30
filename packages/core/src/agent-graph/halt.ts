export * as AgentHalt from "./halt"

import { Context, Effect, Layer, Ref } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"

/**
 * `"finished"` means the agent said it was done, so the halt is released when the
 * drain settles and a later prompt can start fresh work. `"paused"` is an
 * operator decision and outlives the drain, which is what suppresses the
 * successor drain that an in-flight wake can otherwise start after an interrupt.
 */
export const REASON = ["finished", "paused"] as const
export type Reason = (typeof REASON)[number]

export interface Interface {
  readonly request: (agentID: SessionSchema.ID, reason: Reason) => Effect.Effect<void>
  readonly reason: (agentID: SessionSchema.ID) => Effect.Effect<Reason | undefined>
  readonly isHalted: (agentID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Used by a drain that ends for any reason other than an operator pause. */
  readonly settle: (agentID: SessionSchema.ID) => Effect.Effect<void>
  /** The only way a pause ends. */
  readonly release: (agentID: SessionSchema.ID) => Effect.Effect<void>
  readonly haltedAgents: Effect.Effect<ReadonlyArray<SessionSchema.ID>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentHalt") {}

// ponytail: no cap on how often one agent may steer another. There is no evidence
// a cap is needed; if graph testing shows A->B->A->B ping-pong, add a
// wake/delegation budget the way the runner's step allowance is bounded.
const layer = Layer.effect(
  Service,
  Ref.make<ReadonlyMap<SessionSchema.ID, Reason>>(new Map()).pipe(
    Effect.map((state) =>
      Service.of({
        request: Effect.fn("AgentHalt.request")((agentID, reason) =>
          Ref.update(state, (current) => new Map(current).set(agentID, reason)),
        ),
        reason: Effect.fn("AgentHalt.reason")((agentID) =>
          Ref.get(state).pipe(Effect.map((current) => current.get(agentID))),
        ),
        isHalted: Effect.fn("AgentHalt.isHalted")((agentID) =>
          Ref.get(state).pipe(Effect.map((current) => current.has(agentID))),
        ),
        settle: Effect.fn("AgentHalt.settle")((agentID) =>
          Ref.update(state, (current) => {
            if (current.get(agentID) === "finished") {
              const next = new Map(current)
              next.delete(agentID)
              return next
            }
            return current
          }),
        ),
        release: Effect.fn("AgentHalt.release")((agentID) =>
          Ref.update(state, (current) => {
            const next = new Map(current)
            next.delete(agentID)
            return next
          }),
        ),
        haltedAgents: Ref.get(state).pipe(Effect.map((current) => Array.from(current.keys()))),
      }),
    ),
  ),
)

export const node = makeLocationNode({
  name: "agent-halt",
  layer,
  deps: [],
})