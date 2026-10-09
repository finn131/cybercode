export * as PluginPromise from "./promise"

import { define } from "@opencode-ai/plugin/v2/effect"
import type { Plugin, PluginContext, Registration } from "@opencode-ai/plugin/v2/promise"
import { Effect, Scope } from "effect"
import type { AgentDraft } from "@opencode-ai/plugin/v2/promise"

// The Effect host hands back this registration shape; mirror it structurally so
// we do not have to alias the Effect package's `Registration` against the Promise one.
type HostRegistration = { readonly dispose: Effect.Effect<void> }

/**
 * A config-loaded plugin may add subagents, but the identity of an existing
 * primary agent and the pointer to the default one stay reserved for built-ins.
 * That pointer decides what an unprompted session runs, so a package listed in
 * config must not be able to move it, nor quietly redefine a primary that is
 * already there. Violations fail plugin load instead of being dropped, so a
 * rejected write is visible rather than mistaken for an inert plugin.
 *
 * ponytail: creating a new agent is still allowed even at primary mode, because
 * the default pointer is guarded separately and nothing makes such an agent the
 * session default. Tightening that later means changing this one predicate.
 */
function guardExternalAgents(draft: AgentDraft): AgentDraft {
  const isPrimary = (id: string) => {
    const existing = draft.get(id)
    return existing !== undefined && existing.mode !== "subagent"
  }
  return {
    list: draft.list,
    get: draft.get,
    default: (id) => {
      if (id !== undefined)
        throw new Error(
          "plugin: an external plugin cannot set the default agent; define a subagent and let a built-in choose it",
        )
      draft.default(undefined)
    },
    update: (id, fn) => {
      // Only rewriting an existing primary is refused. Creating a new agent is
      // allowed: the default pointer is guarded separately, so a plugin can offer
      // candidates without installing one as the session default.
      if (isPrimary(id))
        throw new Error(`plugin: an external plugin cannot redefine the primary agent "${id}"`)
      draft.update(id, fn)
    },
    remove: (id) => {
      if (isPrimary(id))
        throw new Error(`plugin: an external plugin cannot remove the primary agent "${id}"`)
      draft.remove(id)
    },
  }
}

/**
 * Adapts a Promise plugin into an Effect plugin so the existing Effect-only
 * loader (`PluginV2` / `PluginInternal`) can run it unchanged.
 *
 * Hook registrations created during the async `setup` attach to the plugin's
 * scope, so unloading the plugin disposes them. The captured fiber context
 * preserves boot-time batching, so Promise-plugin transforms still coalesce
 * into one reload per domain.
 */
export function fromPromise(plugin: Plugin) {
  return define({
    id: plugin.id,
    effect: (host) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const context = yield* Effect.context<Scope.Scope>()

        // Run a hook registration on the plugin scope and resolve once it is registered.
        const register = (effect: Effect.Effect<HostRegistration, never, Scope.Scope>): Promise<Registration> =>
          Effect.runPromiseWith(context)(Scope.provide(scope)(effect)).then((registration) => ({
            dispose: () => Effect.runPromiseWith(context)(registration.dispose),
          }))

        const run = (effect: Effect.Effect<void>) => Effect.runPromiseWith(context)(effect)

        const transform =
          <Draft>(domain: {
            transform: (
              callback: (draft: Draft) => Effect.Effect<void> | void,
            ) => Effect.Effect<HostRegistration, never, Scope.Scope>
          }) =>
          (callback: (draft: Draft) => Promise<void> | void) =>
            register(domain.transform((draft) => Effect.promise(() => Promise.resolve(callback(draft)))))

        const context2: PluginContext = {
          options: host.options,
          agent: {
            transform: (callback) =>
              register(
                host.agent.transform((draft) => Effect.promise(() => Promise.resolve(callback(guardExternalAgents(draft))))),
              ),
            reload: () => run(host.agent.reload()),
          },
          aisdk: {
            sdk: (callback) =>
              register(host.aisdk.sdk((event) => Effect.promise(() => Promise.resolve(callback(event))))),
            language: (callback) =>
              register(host.aisdk.language((event) => Effect.promise(() => Promise.resolve(callback(event))))),
          },
          catalog: {
            transform: transform(host.catalog),
            reload: () => run(host.catalog.reload()),
          },
          command: {
            transform: transform(host.command),
            reload: () => run(host.command.reload()),
          },
          integration: {
            transform: transform(host.integration),
            reload: () => run(host.integration.reload()),
            connection: {
              active: (id) => Effect.runPromiseWith(context)(host.integration.connection.active(id)),
              resolve: (connection) => Effect.runPromiseWith(context)(host.integration.connection.resolve(connection)),
            },
          },
          plugin: {
            add: (input) => {
              const child = fromPromise(input)
              return run(host.plugin.add(child))
            },
            remove: (id) => run(host.plugin.remove(id)),
          },
          reference: {
            transform: transform(host.reference),
            reload: () => run(host.reference.reload()),
          },
          skill: {
            transform: transform(host.skill),
            reload: () => run(host.skill.reload()),
          },
        }

        yield* Effect.promise(() => Promise.resolve(plugin.setup(context2)))
      }),
  })
}
