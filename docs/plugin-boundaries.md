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

These decide what the agent can *do*. No built-in registers a model through
them; a contract says external plugins should not either, which the guard below
only enforces for agents so far.

## This seam is not enforced for external plugins

An earlier version of this document claimed external plugins receive only
`{ client, serverUrl }` and therefore cannot reach capabilities. That is true of
the V1 Promise signature (`packages/plugin/src/index.ts:56-74`) but **false** of
the v2 Promise plugin, which `PluginPromise.fromPromise` bridges into the full
`PluginContext` (`promise.ts:45-88`, handed over at `promise.ts:90`). A package
listed in `plugins` receives the same `agent`, `catalog`, `integration` and
`aisdk` surfaces a built-in gets.

The one boundary that is now enforced is the primary-agent one, in
`guardExternalAgents` (`promise.ts`):

- setting the default agent pointer is refused
- rewriting or removing an existing primary agent is refused
- creating a new agent is allowed, at any mode

Creating an agent is allowed because the default pointer is guarded separately,
so a plugin can offer candidates without installing one as the session default.
Creating a primary-mode agent is therefore possible but inert. Tightening that
later means changing one predicate.

`catalog`, `integration` and `aisdk` are deliberately **not** narrowed yet.
Narrowing them would break provider plugins loaded from config, which is a
separate decision.

## Why the agent boundary matters at all

`State.create` registers transforms with a scope finalizer
(`state.ts:89-124`), so `PluginV2.Service.remove` closes the plugin scope and
**disposes every transform that plugin registered** (`plugin.ts:55-60`). A plugin
that wrote into the catalog could therefore delete model registrations for
everybody the moment it was disabled or reloaded. Feature-side drafts are rebuilt
from scratch on each materialize, so the same removal is harmless there.

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

Rules. The first four are enforced by the host; the last is enforced by
`guardExternalAgents`:

1. **ID** is domain-prefixed so a feature plugin can never be mistaken for a
   provider plugin in a log line.
2. **Capabilities are declared, not inferred**, so the set is reviewable without
   reading the effect.
3. **Options** arrive from the config entry `{ package, options }`
   (`config/plugin.ts:5-8`) and are the only configuration surface. No plugin
   reads config documents itself.
4. **Lifecycle is the host's.** Load, reload and unload are `PluginV2.add`,
   `remove` and `wait`. A plugin does not manage its own scope.
5. **No model registration.** Policy only for now — an external plugin still
   receives `catalog`, `integration` and `aisdk`. Narrowing those needs a
   provider-plugins-from-config path first, so it is a separate decision.
6. **No primary-agent identity.** Setting the default pointer, and rewriting or
   removing an existing primary agent, are refused at load time.

## Decisions taken

1. **Built-ins register through `plugin/internal.ts`.** Matches how the built-ins
   load and costs nothing. A published package stays a later step.
2. **Options stay `Record<string, unknown>`** for v1. Typed per-plugin option
   schemas are a later refinement.
3. **External plugins are subagent-only for v1**, enforced by
   `guardExternalAgents`. Creating a new agent remains allowed but inert, since
   the default pointer is separately guarded.

## Not building

- A plugin manager, registry, or loader. `PluginV2` already does this.
- A separate CyberCode plugin runtime.
- Capability negotiation or dependency resolution between plugins beyond
  `plugin.add`.
- Per-plugin enable/disable with its own lifecycle.
- Any catalog or integration access for feature plugins.

## Still open

1. **Whether external plugins may reach `catalog` at all.** Right now they can, and
   the disposal semantics make that risky. Narrowing it means deciding what a
   provider plugin loaded from config looks like.
2. **Whether creating a primary-mode agent should be refused**, not just
   installing one as the default. One predicate in `guardExternalAgents`.
3. **Where the first CyberCode plugin's options are validated.** Nothing
   validates `Record<string, unknown>` today.
