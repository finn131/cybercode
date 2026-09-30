export * as AgentGraph from "./graph"

import { Context, Effect, Layer, Ref, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"

/**
 * A graph node is one agent, keyed by the session that runs it. Keying by session
 * keeps node identity, parentage, and persistence on one identifier, so there is
 * no second mapping table to keep in sync.
 */
export type ID = SessionSchema.ID

// ponytail: `budget_paused` is unreachable until the durable mailbox lands in phase 1b.
// Declared now so phase 1b adds behaviour instead of reshaping the union.
export const STATUS = [
  "running",
  "waiting",
  "completed",
  "stopped",
  "crashed",
  "failed",
  "budget_paused",
] as const
export type Status = (typeof STATUS)[number]

/** No loop will ever read these agents again. */
export const TERMINAL_STATUSES: ReadonlySet<Status> = new Set(["completed", "stopped", "crashed", "failed"])

/** A run is not finished while one of these exists. */
export const ACTIVE_STATUSES: ReadonlySet<Status> = new Set(["running", "waiting", "budget_paused"])

export class UnknownAgentError extends Schema.TaggedErrorClass<UnknownAgentError>()(
  "AgentGraph.UnknownAgentError",
  {
    agentID: SessionSchema.ID,
  },
) {}

export class DuplicateAgentError extends Schema.TaggedErrorClass<DuplicateAgentError>()(
  "AgentGraph.DuplicateAgentError",
  {
    agentID: SessionSchema.ID,
  },
) {}

export interface Node {
  readonly id: ID
  readonly name: string
  readonly parentID?: ID
  readonly status: Status
  readonly task?: string
  readonly skills: ReadonlyArray<string>
  readonly error?: string
}

export interface RegisterInput {
  readonly id: ID
  readonly name: string
  readonly parentID?: ID
  readonly task?: string
  readonly skills?: ReadonlyArray<string>
}

export interface Interface {
  readonly register: (input: RegisterInput) => Effect.Effect<Node, DuplicateAgentError | UnknownAgentError>
  readonly setStatus: (
    agentID: ID,
    status: Status,
    options?: { readonly error?: string },
  ) => Effect.Effect<Node, UnknownAgentError>
  readonly node: (agentID: ID) => Effect.Effect<Node | undefined>
  readonly nodes: Effect.Effect<ReadonlyArray<Node>>
  /** Descendants first, so a caller can stop a subtree before its parent goes idle. */
  readonly subtreeOrder: (agentID: ID) => Effect.Effect<ReadonlyArray<Node>, UnknownAgentError>
  readonly ancestors: (agentID: ID) => Effect.Effect<ReadonlyArray<Node>, UnknownAgentError>
  readonly activeNodes: Effect.Effect<ReadonlyArray<Node>>
  readonly rootNodes: Effect.Effect<ReadonlyArray<Node>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentGraph") {}

const layer = Layer.effect(
  Service,
  Ref.make<ReadonlyMap<ID, Node>>(new Map()).pipe(
    Effect.map((state) =>
      Service.of({
        register: Effect.fn("AgentGraph.register")(function* (input) {
          if (input.parentID && !(yield* Ref.get(state)).has(input.parentID))
            return yield* new UnknownAgentError({ agentID: input.parentID })
          return yield* Ref.modify(state, (current) => {
            if (current.has(input.id)) return [undefined, current]
            const created: Node = {
              id: input.id,
              name: input.name,
              parentID: input.parentID,
              status: "running",
              task: input.task,
              skills: input.skills ?? [],
            }
            return [created, new Map(current).set(created.id, created)]
          }).pipe(
            Effect.flatMap((created) => (created ? Effect.succeed(created) : new DuplicateAgentError({ agentID: input.id }))),
          )
        }),
        setStatus: Effect.fn("AgentGraph.setStatus")(function* (agentID, status, options) {
          return yield* Ref.modify(state, (current) => {
            const existing = current.get(agentID)
            if (!existing) return [undefined, current]
            const next: Node = {
              ...existing,
              status,
              error: options?.error ?? (status === "running" ? undefined : existing.error),
            }
            return [next, new Map(current).set(agentID, next)]
          }).pipe(
            Effect.flatMap((updated) => (updated ? Effect.succeed(updated) : new UnknownAgentError({ agentID }))),
          )
        }),
        node: Effect.fn("AgentGraph.node")((agentID) =>
          Ref.get(state).pipe(Effect.map((current) => current.get(agentID))),
        ),
        nodes: Ref.get(state).pipe(Effect.map((current) => Array.from(current.values()))),
        subtreeOrder: Effect.fn("AgentGraph.subtreeOrder")(function* (agentID) {
          const current = yield* Ref.get(state)
          if (!current.has(agentID)) return yield* new UnknownAgentError({ agentID })
          const order: ID[] = []
          const queue: ID[] = [agentID]
          while (queue.length > 0) {
            const id = queue.shift()!
            order.push(id)
            for (const candidate of current.values()) if (candidate.parentID === id) queue.push(candidate.id)
          }
          return order
            .toReversed()
            .map((id) => current.get(id)!)
        }),
        ancestors: Effect.fn("AgentGraph.ancestors")(function* (agentID) {
          const current = yield* Ref.get(state)
          if (!current.has(agentID)) return yield* new UnknownAgentError({ agentID })
          const chain: ID[] = []
          let cursor = current.get(agentID)!.parentID
          while (cursor && !chain.includes(cursor)) {
            const parent = current.get(cursor)
            if (!parent) break
            chain.push(parent.id)
            cursor = parent.parentID
          }
          return chain.map((id) => current.get(id)!)
        }),
        activeNodes: Ref.get(state).pipe(
          Effect.map((current) => Array.from(current.values()).filter((node) => ACTIVE_STATUSES.has(node.status))),
        ),
        rootNodes: Ref.get(state).pipe(
          Effect.map((current) => Array.from(current.values()).filter((node) => !node.parentID)),
        ),
      }),
    ),
  ),
)

export const node = makeLocationNode({
  name: "agent-graph",
  layer,
  deps: [],
})