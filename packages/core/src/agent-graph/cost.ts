export * as AgentCost from "./cost"

import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Context, Effect, Layer, Ref, Scope, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "../session/schema"
import { AgentGraph } from "./graph"

export interface Usage {
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
}

const zero = (): Usage => ({
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const add = (a: Usage, b: Usage): Usage => ({
  cost: a.cost + b.cost,
  tokens: {
    input: a.tokens.input + b.tokens.input,
    output: a.tokens.output + b.tokens.output,
    reasoning: a.tokens.reasoning + b.tokens.reasoning,
    cache: { read: a.tokens.cache.read + b.tokens.cache.read, write: a.tokens.cache.write + b.tokens.cache.write },
  },
})

export interface Interface {
  /** Spend attributed to one graph node. */
  readonly usage: (agentID: SessionSchema.ID) => Effect.Effect<Usage>
  /** Spend across every node this Location has seen. */
  readonly total: Effect.Effect<Usage>
  readonly nodes: Effect.Effect<ReadonlyArray<{ readonly agentID: SessionSchema.ID; readonly usage: Usage }>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentCost") {}

export type StepEnded = EventV2.Payload<typeof SessionEvent.Step.Ended>

/** Pure spend reducer, kept separate so it can be exercised without an event bus. */
export function reduce(current: ReadonlyMap<SessionSchema.ID, Usage>, event: StepEnded): ReadonlyMap<SessionSchema.ID, Usage> {
  const next = new Map(current)
  next.set(
    event.data.sessionID,
    add(next.get(event.data.sessionID) ?? zero(), {
      cost: event.data.cost,
      tokens: {
        input: event.data.tokens.input,
        output: event.data.tokens.output,
        reasoning: event.data.tokens.reasoning,
        cache: { read: event.data.tokens.cache.read, write: event.data.tokens.cache.write },
      },
    }),
  )
  return next
}

export const start = (): Usage => zero()

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const events = yield* EventV2.Service
    const perNode = yield* Ref.make<ReadonlyMap<SessionSchema.ID, Usage>>(new Map())
    // The event id is the idempotency key that keeps a replay from double-counting spend.
    const seen = yield* Ref.make<ReadonlySet<string>>(new Set())

    const account = Effect.fn("AgentCost.account")(function* (event: StepEnded) {
      if ((yield* Ref.get(seen)).has(event.id)) return
      yield* Ref.update(seen, (current) => new Set(current).add(event.id))
      yield* Ref.update(perNode, (current) => reduce(current, event))
    })

    yield* events
      .subscribe(SessionEvent.Step.Ended)
      .pipe(Stream.runForEach(account), Effect.orDie, Effect.forkIn(scope))

    return Service.of({
      usage: (agentID) => Ref.get(perNode).pipe(Effect.map((current) => current.get(agentID) ?? zero())),
      total: Ref.get(perNode).pipe(
        Effect.map((current) => Array.from(current.values()).reduce((sum, usage) => add(sum, usage), zero())),
      ),
      nodes: Ref.get(perNode).pipe(
        Effect.map((current) => Array.from(current, ([agentID, usage]) => ({ agentID, usage }))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "agent-cost",
  layer,
  deps: [EventV2.node],
})