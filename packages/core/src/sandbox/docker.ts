export * as SandboxDocker from "./docker"

/**
 * Pure docker CLI argument builders, kept free of any Effect or I/O so they can
 * be asserted exactly in tests without a docker daemon.
 *
 * ponytail: shells out to the `docker` CLI rather than adding a client library.
 * One binary, no dependency pin, and the same command the operator would type.
 */

export const SANDBOX_LABEL = "cybercode-sandbox"

export const containerName = (pid: number = process.pid) => `cybercode-${pid}`

/** Parse a container name back to the pid that owned it. */
export const pidFromContainerName = (name: string): number | undefined => {
  const match = /^cybercode-(\d+)$/.exec(name)
  return match ? Number.parseInt(match[1], 10) : undefined
}

export interface MountSpec {
  readonly source: string
  readonly target: string
  readonly readOnly?: boolean
}

export interface RunSpec {
  readonly container: string
  readonly image: string
  readonly cwd: string
  readonly mounts: ReadonlyArray<MountSpec>
  readonly env?: ReadonlyArray<{ readonly key: string; readonly value: string }>
  readonly memory?: string
  readonly pidsLimit?: number
}

export interface ExecSpec {
  readonly container: string
  readonly cwd: string
  readonly script: string
  readonly shell?: string
  readonly env?: ReadonlyArray<{ readonly key: string; readonly value: string }>
}

/**
 * `sleep infinity` is the keep-alive: no entrypoint to satisfy, so the image
 * needs none. `--init` gives PID-1 reaping for the commands exec'd inside.
 */
export function runArgs(spec: RunSpec): Array<string> {
  return [
    "run",
    "-d",
    "--name",
    spec.container,
    "--init",
    "-w",
    spec.cwd,
    ...spec.mounts.flatMap((mount) => [
      "-v",
      mount.readOnly ? `${mount.source}:${mount.target}:ro` : `${mount.source}:${mount.target}`,
    ]),
    "--add-host",
    "host.docker.internal:host-gateway",
    "--log-driver",
    "json-file",
    "--log-opt",
    "max-size=50m",
    "--log-opt",
    "max-file=3",
    "--label",
    SANDBOX_LABEL,
    ...envArgs(spec.env),
    ...(spec.memory ? ["--memory", spec.memory] : []),
    ...(spec.pidsLimit ? ["--pids-limit", String(spec.pidsLimit)] : []),
    spec.image,
    "sleep",
    "infinity",
  ]
}

export function execArgs(spec: ExecSpec): Array<string> {
  return ["exec", "-w", spec.cwd, ...envArgs(spec.env), spec.container, spec.shell ?? "bash", "-lc", spec.script]
}

export function stopArgs(container: string): Array<string> {
  return ["rm", "-f", container]
}

/**
 * Names of every sandbox-labelled container, including siblings. Callers filter
 * by pid liveness before removing anything, so a live session is never torn
 * down by another session's sweep.
 *
 * `-q` is deliberately absent: `--quiet` overrides `--format`, and the names
 * are the whole payload here.
 */
export function listArgs(): Array<string> {
  return ["ps", "-a", "--filter", `label=${SANDBOX_LABEL}`, "--format", "{{.Names}}"]
}

function envArgs(env: ReadonlyArray<{ key: string; value: string }> | undefined): Array<string> {
  return env?.flatMap((item) => ["-e", `${item.key}=${item.value}`]) ?? []
}