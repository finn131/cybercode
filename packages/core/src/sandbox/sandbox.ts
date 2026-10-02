export * as Sandbox from "./sandbox"

import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "../cross-spawn-spawner"
import { Context, Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { AppProcessError, collectStream, type RunResult } from "../process"
import { SandboxDocker } from "./docker"

export interface RunInput {
  /** Where the command runs. Must be inside `location`, or the exec will fail. */
  readonly cwd: string
  readonly script: string
  readonly timeout: Duration.Duration
  readonly maxOutputBytes: number
  readonly image: string
  /**
   * Mounted into the container at this exact path, and the container's own
   * working directory.
   *
   * The mount is intentionally the Location root and not the command's cwd.
   * The container is created once and reused, so mounting whatever the first
   * command happened to name would hide the rest of the tree from every later
   * command. It also has to be the same absolute path the host sees: bash
   * permissions and the external-directory advisory both compare against it.
   *
   * ponytail: external workdirs approved outside the Location are not mounted,
   * so `docker exec -w` on them fails. Mount them per-run when that matters.
   */
  readonly location: string
}

/**
 * One container for the life of this process: started on first `run`, reused for
 * every command, torn down only by an orphan sweep in a later process. Chosen so
 * a long pentest does not pay `docker run` per command.
 */
export interface Interface {
  readonly run: (input: RunInput) => Effect.Effect<RunResult, AppProcessError, never>
  /** Best-effort teardown; a failure here must never fail the caller. */
  readonly stop: Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sandbox") {}

const DOCKER_TIMEOUT = Duration.seconds(60)

const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const docker = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("docker", [...args], { stdin: "ignore" }))
          const all = yield* collectStream(handle.all, 1024 * 1024)
          const exitCode = yield* handle.exitCode
          return { exitCode, output: all.buffer.toString("utf8"), truncated: all.truncated }
        }),
      )

    let container = ""
    let swept = false

    const ensureStarted = (spec: Pick<RunInput, "image" | "location">) =>
      Effect.gen(function* () {
        if (container) return container
        // Sweeping before we claim our name reclaims a container left behind by
        // a hard-killed previous process. Deferred to first use so a run with
        // the gate off never touches docker at all.
        if (!swept) {
          swept = true
          const listed = yield* docker(SandboxDocker.listArgs())
          for (const name of listed.output.split("\n")) {
            const trimmed = name.trim()
            if (trimmed.length === 0) continue
            const pid = SandboxDocker.pidFromContainerName(trimmed)
            if (pid !== undefined && isPidAlive(pid)) continue
            yield* docker(SandboxDocker.stopArgs(trimmed)).pipe(Effect.catch(() => Effect.void))
            yield* Effect.logInfo("sandbox: removed orphaned container", { container: trimmed })
          }
        }
        const name = SandboxDocker.containerName()
        const args = SandboxDocker.runArgs({
          container: name,
          image: spec.image,
          cwd: spec.location,
          mounts: [{ source: spec.location, target: spec.location }],
        })
        const started = yield* docker(args).pipe(
          Effect.timeout(DOCKER_TIMEOUT),
          Effect.catch((cause) => new AppProcessError({ command: args.join(" "), cause })),
        )
        if (started.exitCode !== 0)
          return yield* new AppProcessError({
            command: args.join(" "),
            exitCode: started.exitCode,
            stderr: started.output,
          })
        container = name
        yield* Effect.logInfo("sandbox: started container", { container: name, image: spec.image })
        return container
      })

    const run = (input: RunInput) =>
      Effect.gen(function* () {
        const name = yield* ensureStarted(input)
        const args = SandboxDocker.execArgs({ container: name, cwd: input.cwd, script: input.script })
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make("docker", [...args], { stdin: "ignore" }))
            const output = yield* collectStream(handle.all, input.maxOutputBytes)
            const exitCode = yield* handle.exitCode
            return { output, exitCode }
          }),
        )
        const runResult: RunResult = {
          command: `${name}$ ${input.script}`,
          exitCode: result.exitCode,
          output: result.output.buffer,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          outputTruncated: result.output.truncated,
          stdoutTruncated: false,
          stderrTruncated: false,
        }
        return runResult
      }).pipe(
        Effect.timeoutOrElse({
          duration: input.timeout,
          orElse: () => Effect.fail(new AppProcessError({ command: input.script, cause: new Error("Timed out") })),
        }),
        Effect.catch((cause) =>
          cause instanceof AppProcessError
            ? Effect.fail(cause)
            : Effect.fail(new AppProcessError({ command: input.script, cause })),
        ),
      )

    const stop = Effect.gen(function* () {
      if (container === "") return
      const name = container
      container = ""
      yield* docker(SandboxDocker.stopArgs(name)).pipe(Effect.catch(() => Effect.void))
      yield* Effect.logInfo("sandbox: stopped container", { container: name })
    })

    return Service.of({ run, stop })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [CrossSpawnSpawner.node] })