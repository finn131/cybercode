import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AgentCost } from "@opencode-ai/core/agent-graph/cost"
import { AgentGraph } from "@opencode-ai/core/agent-graph/graph"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(AgentGraph.node))

const id = (value: string) => SessionSchema.ID.make(value)

const seed = (graph: AgentGraph.Interface) =>
  Effect.gen(function* () {
    const root = yield* graph.register({ id: id("ses_root"), name: "root" })
    const left = yield* graph.register({ id: id("ses_left"), name: "left", parentID: root.id })
    const right = yield* graph.register({ id: id("ses_right"), name: "right", parentID: root.id })
    const leaf = yield* graph.register({ id: id("ses_leaf"), name: "leaf", parentID: left.id })
    return { root, left, right, leaf }
  })

describe("AgentGraph registration", () => {
  it.effect("links children to their parent and starts them running", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const { root, left } = yield* seed(graph)

      expect(left.parentID).toBe(root.id)
      expect(left.status).toBe("running")
      expect(root.parentID).toBeUndefined()
      expect((yield* graph.node(id("ses_left")))).toMatchObject({ name: "left", parentID: root.id })
    }),
  )

  it.effect("rejects a duplicate id", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      yield* graph.register({ id: id("ses_root"), name: "root" })

      const exit = yield* graph.register({ id: id("ses_root"), name: "again" }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* graph.nodes).length).toBe(1)
    }),
  )

  it.effect("rejects a parent that was never registered", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service

      const exit = yield* graph
        .register({ id: id("ses_child"), name: "child", parentID: id("ses_ghost") })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* graph.nodes).length).toBe(0)
    }),
  )

  it.effect("reports an unregistered node as absent", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service

      expect(yield* graph.node(id("ses_ghost"))).toBeUndefined()
    }),
  )
})

describe("AgentGraph status", () => {
  it.effect("carries an error through a non-running transition and clears it on return", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const { left } = yield* seed(graph)

      yield* graph.setStatus(left.id, "failed", { error: "boom" })
      expect((yield* graph.node(left.id))?.error).toBe("boom")

      yield* graph.setStatus(left.id, "running")
      expect((yield* graph.node(left.id))?.error).toBeUndefined()
    }),
  )

  it.effect("refuses a transition on an unknown node", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service

      expect(Exit.isFailure(yield* graph.setStatus(id("ses_ghost"), "completed").pipe(Effect.exit))).toBe(true)
    }),
  )

  it.effect("classifies statuses into terminal and active sets", () =>
    Effect.sync(() => {
      expect(Array.from(AgentGraph.TERMINAL_STATUSES).toSorted()).toEqual(["completed", "crashed", "failed", "stopped"])
      expect(Array.from(AgentGraph.ACTIVE_STATUSES).toSorted()).toEqual(["budget_paused", "running", "waiting"])
    }),
  )

  it.effect("hides terminal nodes from the active set", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const { root, left, right, leaf } = yield* seed(graph)

      yield* graph.setStatus(left.id, "completed")

      expect((yield* graph.activeNodes).map((node) => node.id)).toEqual([root.id, right.id, leaf.id])
      expect((yield* graph.rootNodes).map((node) => node.name)).toEqual(["root"])
    }),
  )
})

describe("AgentGraph traversal", () => {
  it.effect("orders a subtree descendants-first", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const { root, leaf } = yield* seed(graph)

      const order = yield* graph.subtreeOrder(root.id)

      expect(order.map((node) => node.id)).toEqual([leaf.id, ...order.slice(1).map((node) => node.id)])
      expect(order.at(-1)?.id).toBe(root.id)
      expect(order.map((node) => node.id)).toContain(leaf.id)
    }),
  )

  it.effect("walks ancestors up to the root", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const { root, left, leaf } = yield* seed(graph)

      expect((yield* graph.ancestors(leaf.id)).map((node) => node.id)).toEqual([left.id, root.id])
      expect(yield* graph.ancestors(root.id)).toEqual([])
    }),
  )

  it.effect("rejects traversal from an unknown node", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service

      expect(Exit.isFailure(yield* graph.subtreeOrder(id("ses_ghost")).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* graph.ancestors(id("ses_ghost")).pipe(Effect.exit))).toBe(true)
    }),
  )
})

const stepEnded = (sessionID: string, eventID: string, cost: number, tokens = 0) => ({
  id: eventID,
  data: {
    sessionID: id(sessionID),
    cost,
    tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
}) as unknown as AgentCost.StepEnded

describe("AgentCost reducer", () => {
  it.effect("starts every node at zero", () =>
    Effect.gen(function* () {
      expect(AgentCost.start()).toEqual({
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }),
  )

  it.effect("sums repeated steps for the same node", () =>
    Effect.sync(() => {
      let usage: ReadonlyMap<SessionSchema.ID, AgentCost.Usage> = new Map()
      usage = AgentCost.reduce(usage, stepEnded("ses_a", "evt_1", 0.5, 10))
      usage = AgentCost.reduce(usage, stepEnded("ses_a", "evt_2", 0.25, 5))

      expect(usage.get(id("ses_a"))).toEqual({
        cost: 0.75,
        tokens: { input: 15, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }),
  )

  it.effect("keeps separate nodes apart", () =>
    Effect.sync(() => {
      let usage: ReadonlyMap<SessionSchema.ID, AgentCost.Usage> = new Map()
      usage = AgentCost.reduce(usage, stepEnded("ses_a", "evt_1", 1))
      usage = AgentCost.reduce(usage, stepEnded("ses_b", "evt_2", 2))

      expect(usage.get(id("ses_a"))?.cost).toBe(1)
      expect(usage.get(id("ses_b"))?.cost).toBe(2)
      expect(usage.size).toBe(2)
    }),
  )

  it.effect("does not mutate the map it is given", () =>
    Effect.sync(() => {
      const before: ReadonlyMap<SessionSchema.ID, AgentCost.Usage> = new Map()
      const after = AgentCost.reduce(before, stepEnded("ses_a", "evt_1", 3))

      expect(before.size).toBe(0)
      expect(after.size).toBe(1)
    }),
  )

  it.effect("accounts the same event id only once", () =>
    Effect.sync(() => {
      const event = stepEnded("ses_a", "evt_1", 4)
      const seen = new Set<string>()
      const guard = (current: ReadonlyMap<SessionSchema.ID, AgentCost.Usage>) => {
        if (seen.has(event.id)) return current
        seen.add(event.id)
        return AgentCost.reduce(current, event)
      }

      const once = guard(new Map())
      expect(once.get(id("ses_a"))?.cost).toBe(4)
      expect(guard(once).get(id("ses_a"))?.cost).toBe(4)
    }),
  )
})