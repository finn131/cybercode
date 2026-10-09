import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { PluginPromise } from "@opencode-ai/core/plugin/promise"
import { define } from "@opencode-ai/plugin/v2/promise"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("fromPromise", () => {
  it.effect("loads a promise plugin and registers a transform hook", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = define({
        id: "promise-example",
        setup: async (ctx) => {
          expect(ctx.options.mode).toBe("strict")
          await ctx.agent.transform((draft) => {
            draft.update("reviewer", (item) => {
              item.description = "Reviews code"
              item.mode = "subagent"
            })
          })
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect({ ...host, options: { mode: "strict" } })

      expect(yield* agents.get(AgentV2.ID.make("reviewer"))).toMatchObject({
        description: "Reviews code",
        mode: "subagent",
      })
    }),
  )

  it.effect("disposes a hook registration on request", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = define({
        id: "promise-dispose",
        setup: async (ctx) => {
          const registration = await ctx.agent.transform((draft) => {
            draft.update("temp", (item) => {
              item.description = "temporary"
            })
          })
          await registration.dispose()
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect(host)

      expect(yield* agents.get(AgentV2.ID.make("temp"))).toBeUndefined()
    }),
  )
})

describe("external plugin agent boundaries", () => {
  const runPlugin = (id: string, setup: (ctx: Parameters<Parameters<typeof define>[0]["setup"]>[0]) => Promise<void>) =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      yield* PluginPromise.fromPromise(define({ id, setup })).effect(host)
    })

  // Seeding goes through the unrestricted built-in path: what an external plugin
  // may not do is exactly what a built-in must be able to do first.
  const seedPrimary = (id: string) =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) => {
        draft.update(AgentV2.ID.make(id), (item) => {
          item.mode = "primary"
          item.description = "builtin primary"
        })
        draft.default(AgentV2.ID.make(id))
      })
    })

  it.effect("lets an external plugin add a subagent", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* runPlugin("ext-subagent", async (ctx) => {
        await ctx.agent.transform((draft) => {
          draft.update("pentest-recon", (item) => {
            item.mode = "subagent"
            item.description = "Recon specialist"
          })
        })
      })

      expect(yield* agents.get(AgentV2.ID.make("pentest-recon"))).toMatchObject({ mode: "subagent" })
    }),
  )

  it.effect("refuses to let an external plugin set the default agent", () =>
    Effect.gen(function* () {
      yield* seedPrimary("build")
      const exit = yield* runPlugin("ext-default", async (ctx) => {
        await ctx.agent.transform((draft) => {
          draft.default("build")
        })
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("refuses to let an external plugin define a primary agent", () =>
    Effect.gen(function* () {
      yield* seedPrimary("build")
      const exit = yield* runPlugin("ext-primary", async (ctx) => {
        await ctx.agent.transform((draft) => {
          draft.update("build", (item) => {
            item.description = "hijacked"
          })
        })
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("refuses to let an external plugin remove a primary agent", () =>
    Effect.gen(function* () {
      yield* seedPrimary("build")
      const exit = yield* runPlugin("ext-remove", async (ctx) => {
        await ctx.agent.transform((draft) => {
          draft.remove("build")
        })
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("still lets an external plugin read agents and clear the default pointer", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* seedPrimary("build")
      yield* runPlugin("ext-read", async (ctx) => {
        await ctx.agent.transform((draft) => {
          expect(draft.get("build")).toBeDefined()
          draft.list()
          draft.default(undefined)
        })
      })

      expect(yield* agents.get(AgentV2.ID.make("build"))).toBeDefined()
    }),
  )
})
