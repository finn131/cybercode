import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentBootstrap } from "@opencode-ai/core/agent-graph/bootstrap"
import { AgentGraph } from "@opencode-ai/core/agent-graph/graph"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Config } from "@opencode-ai/core/config"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"
import { ConfigAgentGraph } from "@opencode-ai/core/config/agent-graph"

const it = testEffect(AppNodeBuilder.build(AgentGraph.node))

const id = (value: string) => SessionSchema.ID.make(value)

function makeConfig(agentGraph?: ConfigAgentGraph.Info): Config.Interface {
  return {
    entries: () => Effect.succeed(agentGraph ? [{ type: "document", path: "/test/config.json", info: { agent_graph: agentGraph } } as any] : []),
  } as unknown as Config.Interface
}

describe("AgentBootstrap.registerForPrompt", () => {
  it.effect("is a no-op when the gate is off", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const config = makeConfig()

      yield* AgentBootstrap.registerForPrompt(
        { graph, config },
        { sessionID: id("ses_a"), agent: "build" },
      )

      expect(yield* graph.nodes).toEqual([])
    }),
  )

  it.effect("registers a node when the gate is on", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const config = makeConfig(ConfigAgentGraph.Info.make({ enabled: true }))

      yield* AgentBootstrap.registerForPrompt(
        { graph, config },
        { sessionID: id("ses_a"), agent: "build" },
      )

      expect(yield* graph.nodes).toHaveLength(1)
      expect((yield* graph.nodes)[0]).toMatchObject({ id: id("ses_a"), name: "build", status: "running" })
    }),
  )

  it.effect("is idempotent across repeated prompts", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const config = makeConfig(ConfigAgentGraph.Info.make({ enabled: true }))
      const input = { sessionID: id("ses_a"), agent: "build" }

      yield* AgentBootstrap.registerForPrompt({ graph, config }, input)
      yield* AgentBootstrap.registerForPrompt({ graph, config }, input)

      expect(yield* graph.nodes).toHaveLength(1)
    }),
  )

  it.effect("links a child to its parent", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const config = makeConfig(ConfigAgentGraph.Info.make({ enabled: true }))
      const parent = { sessionID: id("ses_p"), agent: "build" }
      const child = { sessionID: id("ses_c"), agent: "build", parentID: id("ses_p") }

      yield* AgentBootstrap.registerForPrompt({ graph, config }, parent)
      yield* AgentBootstrap.registerForPrompt({ graph, config }, child)

      expect((yield* graph.node(id("ses_c")))?.parentID).toBe(id("ses_p"))
    }),
  )

  it.effect("falls back to a root node when the parent is unknown", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const config = makeConfig(ConfigAgentGraph.Info.make({ enabled: true }))

      yield* AgentBootstrap.registerForPrompt(
        { graph, config },
        { sessionID: id("ses_c"), agent: "build", parentID: id("ses_ghost") },
      )

      const node = yield* graph.node(id("ses_c"))
      expect(node).toBeDefined()
      expect(node?.parentID).toBeUndefined()
    }),
  )

  it.effect("respects the gate for each call independently", () =>
    Effect.gen(function* () {
      const graph = yield* AgentGraph.Service
      const config = makeConfig(ConfigAgentGraph.Info.make({ enabled: false }))

      yield* AgentBootstrap.registerForPrompt({ graph, config }, { sessionID: id("ses_a"), agent: "build" })
      expect(yield* graph.nodes).toEqual([])
    }),
  )
})