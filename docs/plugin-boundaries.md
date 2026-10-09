# Plugin boundaries in cybercode

Status: design review, not a runtime. Nothing here is implemented yet.

The point of this document is to keep the CyberCode plugin surface small. The
fork already has a plugin system with a clear seam in it, so the job is to use
that seam rather than to add a second one.

## What already exists

`PluginHost.make` hands every plugin a `PluginContext`
(`packages/core/src/plugin/host.ts:29-218`). The capabilities are already split
into two groups that mean different things.

### Provider side — model plumbing

| Capability | Location | Purpose |
|---|---|---|
| `catalog.transform` | `host.ts:72-97` | Register and mutate providers and models |
| `integration.transform` | `host.ts:113` | Register and mutate provider connections |
| `aisdk.sdk` | `host.ts:45-57` | Supply the AI SDK implementation for a model |
| `aisdk.language` | `host.ts:58-70` | Supply the language model for a model |

These decide what is *callable*. `CatalogV2.provider.available()`
(`catalog.ts:184-188`) only lists providers that pass `disabled`, a string
`request.body.apiKey`, a live connection, or having no integration at all.

### Feature side — what the agent experiences

| Capability | Location | Purpose |
|---|---|---|
| `agent.transform` | `host.ts:33-42` | Define and update agents |
| `command.transform` | `host.ts:99` | Define commands |
| `skill.transform` | `host.ts:208-217` | Publish skills |
| `reference.transform` | `host.ts:197-207` | Publish named references |
| `plugin.add` | `host.ts:193-196` | Register another plugin |

These decide what the agent can *do*. They never touch the model catalog.

## The rule

> A CyberCode feature plugin uses the feature side only. It reads
> `catalog`/`integration`/`aisdk` exclusively through what the host already
> resolves for it, and never registers a provider or a model.

The reason is concrete. `State.create` registers transforms with a scope
finalizer (`state.ts:89-124`), so `PluginV2.Service.remove` closes the plugin
scope and **disposes every transform that plugin registered**
(`plugin.ts:55-60`). A feature plugin that wrote into the catalog could therefore
delete model registrations for everybody the moment it was disabled or reloaded.
Feature-side drafts are rebuilt from scratch on each materialize, so the same
removal is harmless there.

Provider plugins have the opposite lifecycle requirement and are already handled
by the built-ins: `ConfigProviderPlugin`, `ModelsDevPlugin` and `ProviderPlugins`
in `plugin/internal.ts:110-121`.

## Enabled means different things for plugins and providers

Providers already separate four states. Plugins should not borrow that language.

| State | Applies to | Meaning | Where it lives |
|---|---|---|---|
| Configured | provider | A config document declares it | `catalog.provider` |
| Available | provider | Passes runtime requirements | `catalog.ts:71-76` |
| Enabled | both | May be selected by a resolver | `model.enabled` |
| Invocable | provider | A request can actually be sent and answered | not tracked, proven by invocation |

For a **feature** plugin the only honest states are loaded and not loaded:

| State | Meaning | Mechanism |
|---|---|---|
| Listed | `plugins` names it in config | `config/plugin.ts:5-11` |
| Loaded | Its effect ran under a live scope | `PluginV2.add`, `plugin.ts:43` |
| Failed | Its effect died | `failures` map, `plugin.ts:40` |
| Enabled | — | not a plugin concept |

A plugin does not get a separate enable flag. Whether its capabilities appear in
the catalog is the only thing that matters, and that is already derived from the
transforms it registered.

## Minimal contract for a CyberCode feature plugin

```ts
type CyberCodePlugin = {
  id: string                  // domain-prefixed, e.g. "cybercode/pentest-web"
  capabilities: ("agent" | "command" | "skill" | "reference")[]
  effect: (ctx: PluginContext, options: Record<string, unknown>) => Effect<void, never, never>
}
```

Rules, all of which are already enforced by the host:

1. **ID** is domain-prefixed so a feature plugin can never be mistaken for a
   provider plugin in a log line.
2. **Capabilities are declared, not inferred**, so the set is reviewable without
   reading the effect.
3. **Options** arrive from the config entry `{ package, options }`
   (`config/plugin.ts:5-8`) and are the only configuration surface. No plugin
   reads config documents itself.
4. **Lifecycle is the host's.** Load, reload and unload are `PluginV2.add`,
   `remove` and `wait`. A plugin does not manage its own scope.
5. **No model registration.** Not now, not later, not behind a flag.

## Not building

- A plugin manager, registry, or loader. `PluginV2` already does this.
- A separate CyberCode plugin runtime.
- Capability negotiation or dependency resolution between plugins beyond
  `plugin.add`.
- Per-plugin enable/disable with its own lifecycle.
- Any catalog or integration access for feature plugins.

## Open decisions

1. **Where a first plugin lives.** `plugins: ["cybercode-pentest-web"]` from npm
   is the existing path, but this fork has not published anything. Bundling the
   first plugins through `plugin/internal.ts` matches how the built-ins load and
   costs nothing.
2. **Options shape.** Free-form `Record<string, unknown>` today. Typed option
   schemas per plugin are the obvious later step, not a starting point.
3. **Whether feature plugins may publish agents at all.** `agent.transform` can
   define primary agents, which is more reach than a pentest helper needs.
   Restricting to subagents is a decision worth making before the first plugin
   ships, not after.
