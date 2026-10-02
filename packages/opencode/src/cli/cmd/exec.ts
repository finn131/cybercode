import { Effect } from "effect"
import type { Argv } from "yargs"
import { effectCmd, fail } from "../effect-cmd"

export const ExecCommand = effectCmd({
  command: "exec [message..]",
  describe: "run a session through the V2 surface (experimental)",
  instance: true,
  directory: () => process.cwd(),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", { describe: "message to send", type: "string", array: true, default: [] })
      .option("agent", { type: "string", describe: "agent to use" })
      .option("model", { type: "string", describe: "model override (provider/model)" })
      .option("interval", { type: "number", default: 500, describe: "idle poll interval in ms" })
      .option("min-polls", { type: "number", default: 2, describe: "polls before allowing an idle exit" }),
  handler: Effect.fn("Cli.exec")(function* (args) {
    const message = [...args.message, ...(args["--"] || [])].join(" ")
    if (!message.trim()) return yield* fail("You must provide a message", 1)

    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const { createOpencodeClient } = yield* Effect.promise(() => import("@opencode-ai/sdk/v2"))
    const { executeV2 } = yield* Effect.promise(() => import("./run-v2/execute"))
    const { SandboxDocker } = yield* Effect.promise(() => import("@opencode-ai/core/sandbox/docker"))

    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      const auth = ServerAuth.header()
      if (auth) headers.set("Authorization", auth)
      return Server.Default().app.fetch(new Request(request, { headers }))
    }) as typeof globalThis.fetch

    const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch, directory: process.cwd() })

    const containerName = SandboxDocker.containerName()

    const result = yield* Effect.ensuring(
      Effect.promise(() =>
        executeV2(
          {
            create: sdk.v2.session.create.bind(sdk.v2.session),
            prompt: sdk.v2.session.prompt.bind(sdk.v2.session),
            events: sdk.v2.session.events.bind(sdk.v2.session),
            active: sdk.v2.session.active.bind(sdk.v2.session),
          },
          {
            message,
            directory: process.cwd(),
            agent: args.agent,
            model: args.model,
            pollIntervalMs: args.interval,
            minActivePolls: args["min-polls"],
            onEvent: (event) => {
              if (event.kind === "text") return process.stdout.write(event.text + "\n")
              if (event.kind === "cost") return process.stdout.write(`  cost: $${event.cost.toFixed(4)}\n`)
              return process.stdout.write(`  ${event.outcome}: ${event.name}\n`)
            },
          },
        ),
      ),
      Effect.sync(() => {
        try {
          void Bun.spawn(["docker", "rm", "-f", containerName]).exited.catch(() => {})
        } catch {}
      }),
    )

    if (result.error) return yield* fail(result.error, 1)
    process.exitCode = result.exitCode
  }),
})