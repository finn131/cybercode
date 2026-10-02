import { describe, expect, test } from "bun:test"
import { SandboxDocker } from "../src/sandbox/docker"
import { ConfigSandbox } from "../src/config/sandbox"

describe("SandboxDocker container identity", () => {
  test("names the container after the owning process", () => {
    expect(SandboxDocker.containerName(1234)).toBe("cybercode-1234")
    expect(SandboxDocker.pidFromContainerName("cybercode-1234")).toBe(1234)
  })

  test("ignores names it did not mint", () => {
    expect(SandboxDocker.pidFromContainerName("some-other-container")).toBeUndefined()
    expect(SandboxDocker.pidFromContainerName("cybercode-")).toBeUndefined()
  })

  test("round-trips the default process pid", () => {
    expect(SandboxDocker.pidFromContainerName(SandboxDocker.containerName())).toBe(process.pid)
  })
})

describe("SandboxDocker run args", () => {
  const spec = {
    container: "cybercode-1",
    image: "cybercode/sandbox:base",
    cwd: "/home/user/proj",
    mounts: [{ source: "/home/user/proj", target: "/home/user/proj" }],
  }

  test("keeps the container alive with sleep infinity", () => {
    const args = SandboxDocker.runArgs(spec)
    expect(args.slice(0, 2)).toEqual(["run", "-d"])
    expect(args).toContain("--name")
    expect(args).toContain("cybercode-1")
    expect(args).toContain("--init")
    expect(args.at(-2)).toBe("sleep")
    expect(args.at(-1)).toBe("infinity")
  })

  test("mounts the workspace at the identical host path", () => {
    const args = SandboxDocker.runArgs(spec)
    expect(args).toContain("-v")
    expect(args).toContain("/home/user/proj:/home/user/proj")
  })

  test("honours a read-only mount", () => {
    const args = SandboxDocker.runArgs({
      ...spec,
      mounts: [{ source: "/src", target: "/src", readOnly: true }],
    })
    expect(args).toContain("/src:/src:ro")
  })

  test("publishes the host gateway and label, with log limits", () => {
    const args = SandboxDocker.runArgs(spec)
    expect(args).toContain("--add-host")
    expect(args).toContain("host.docker.internal:host-gateway")
    expect(args).toContain("--label")
    expect(args).toContain(SandboxDocker.SANDBOX_LABEL)
    expect(args).toContain("max-size=50m")
    expect(args).toContain("max-file=3")
  })

  test("passes memory and pids limits only when set", () => {
    const plain = SandboxDocker.runArgs(spec)
    expect(plain).not.toContain("--memory")
    expect(plain).not.toContain("--pids-limit")

    const limited = SandboxDocker.runArgs({ ...spec, memory: "512m", pidsLimit: 256 })
    expect(limited).toContain("--memory")
    expect(limited).toContain("512m")
    expect(limited).toContain("--pids-limit")
    expect(limited).toContain("256")
  })
})

describe("SandboxDocker exec args", () => {
  test("runs a login shell at the requested cwd", () => {
    const args = SandboxDocker.execArgs({ container: "cybercode-1", cwd: "/w", script: "nmap -sV 10.0.0.1" })
    expect(args.slice(0, 2)).toEqual(["exec", "-w"])
    expect(args).toContain("/w")
    expect(args).toContain("cybercode-1")
    expect(args).toContain("bash")
    expect(args).toContain("-lc")
    expect(args.at(-1)).toBe("nmap -sV 10.0.0.1")
  })

  test("accepts an explicit shell", () => {
    const args = SandboxDocker.execArgs({ container: "cybercode-1", cwd: "/w", script: "echo hi", shell: "sh" })
    expect(args).toContain("sh")
    expect(args).not.toContain("bash")
  })

  test("injects env vars", () => {
    const args = SandboxDocker.execArgs({
      container: "cybercode-1",
      cwd: "/w",
      script: "echo hi",
      env: [{ key: "FOO", value: "bar" }],
    })
    expect(args).toContain("-e")
    expect(args).toContain("FOO=bar")
  })
})

describe("SandboxDocker teardown", () => {
  test("removes a container by name", () => {
    expect(SandboxDocker.stopArgs("cybercode-1")).toEqual(["rm", "-f", "cybercode-1"])
  })

  test("lists every sandbox-labelled container without filtering pid", () => {
    // A live sibling must not be swept by another process's startup, so the
    // label is the only filter here; callers check pid liveness themselves.
    const args = SandboxDocker.listArgs()
    expect(args).toContain("ps")
    expect(args).toContain(`label=${SandboxDocker.SANDBOX_LABEL}`)
    expect(args).toContain("{{.Names}}")
  })
})

describe("Sandbox config gate", () => {
  test("is off unless configured", () => {
    expect(ConfigSandbox.Info.make({}).enabled).toBeUndefined()
  })

  test("round-trips enabled and image", () => {
    expect(ConfigSandbox.Info.make({ enabled: true }).enabled).toBe(true)
    expect(ConfigSandbox.Info.make({ enabled: false }).enabled).toBe(false)
    expect(ConfigSandbox.Info.make({ image: "cybercode/sandbox:base" }).image).toBe("cybercode/sandbox:base")
  })
})