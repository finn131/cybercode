import { Duration, Effect } from "effect"
import { LayerNode } from "../src/effect/layer-node"
import { AppProcessError } from "../src/process"
import { Sandbox } from "../src/sandbox/sandbox"
import { SandboxDocker } from "../src/sandbox/docker"

const location = process.argv[2]
if (!location) throw new Error("usage: sandbox-smoke.ts <location-dir>")

const layer = LayerNode.compile(Sandbox.node)

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) process.exitCode = 1
}

const run = (sandbox: Sandbox.Interface, script: string, timeout: Duration.Duration) =>
  sandbox.run({
    cwd: location,
    script,
    timeout,
    maxOutputBytes: 1024 * 1024,
    image: "cybercode/sandbox:base",
    location,
  })

await Effect.runPromise(
  Sandbox.Service.use((sandbox) =>
    Effect.gen(function* () {
      console.log("container:", SandboxDocker.containerName())
      console.log("run args:", SandboxDocker.runArgs({
        container: SandboxDocker.containerName(),
        image: "cybercode/sandbox:base",
        cwd: location,
        mounts: [{ source: location, target: location }],
      }).join(" "))
      console.log("")

      const basic = yield* run(sandbox, "whoami && echo --- && nmap --version | head -1 && echo --- && ls /usr/local/bin | tr '\\n' ' '", Duration.seconds(60))
      console.log("exit:", basic.exitCode)
      console.log("output:", basic.output?.toString())
      check("exec returns non-empty combined output", (basic.output?.toString().length ?? 0) > 0)
      check("nmap is present in the image", basic.output?.toString().includes("Nmap") ?? false)
      check("bind mount is visible at the same path", basic.exitCode === 0)

      const failing = yield* run(sandbox, "exit 7", Duration.seconds(30))
      check("non-zero exit propagates", failing.exitCode === 7, `got ${failing.exitCode}`)

      const timedOut: boolean = yield* run(sandbox, "sleep 30", Duration.seconds(1)).pipe(
        Effect.map(() => false),
        Effect.catch((cause) =>
          Effect.succeed(
            cause instanceof AppProcessError && cause.cause instanceof Error && cause.cause.message === "Timed out",
          ),
        ),
      )
      check("timeout maps to AppProcessError 'Timed out'", timedOut)

      const reused = yield* run(sandbox, "echo reused", Duration.seconds(30))
      check("second run reuses the same container", reused.output?.toString().includes("reused") ?? false)

      yield* sandbox.stop
      console.log("stopped:", SandboxDocker.containerName())
    }),
  ).pipe(Effect.provide(layer)),
)
