import { describe, expect, test } from "bun:test"
import { executeV2, type RenderEvent, type V2Api } from "../../src/cli/cmd/run-v2/execute"

const text = (value: string) => ({ data: { id: "evt_1", type: "session.next.text.ended", data: { text: value } } })
const step = (cost: number) => ({ data: { id: "evt_2", type: "session.next.step.ended", data: { cost } } })
const toolCalled = (callID: string, tool: string) => ({
  data: { id: "evt_3", type: "session.next.tool.called", data: { callID, tool } },
})
const toolResult = (callID: string, type: "success" | "failed") => ({
  data: { id: "evt_4", type: `session.next.tool.${type}` as const, data: { callID } },
})
const unknown = () => ({ data: { id: "evt_5", type: "session.next.step.started", data: {} } })

type Script = ReadonlyArray<unknown>
type ActiveScript = ReadonlyArray<Record<string, unknown> | undefined>

function fakeApi(script: Script, active: ActiveScript): V2Api {
  let poll = 0
  return {
    create: async () => ({ data: { data: { id: "ses_abc" } } }),
    prompt: async () => ({ data: { id: "msg_1" } }),
    events: async () => ({
      stream: (async function* () {
        for (const item of script) yield item
      })(),
    }),
    active: async () => {
      const slot = active[Math.min(poll++, active.length - 1)]
      return slot === undefined ? { data: {} } : { data: slot }
    },
  }
}

function base(over: Partial<Parameters<typeof executeV2>[1]> = {}) {
  return {
    message: "scan the target",
    directory: "/project",
    pollIntervalMs: 1,
    minActivePolls: 2,
    onEvent: () => {},
    ...over,
  } as Parameters<typeof executeV2>[1]
}

describe("executeV2 exit codes", () => {
  test("returns 0 on a clean run", async () => {
    const events: RenderEvent[] = []
    const result = await executeV2(fakeApi([text("hello"), step(0.5), unknown()], [undefined, undefined]), base({ onEvent: (e) => events.push(e) }))

    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.sawLifecycleFinish).toBe(false)
    expect(events).toContainEqual({ kind: "text", text: "hello" })
    expect(events).toContainEqual({ kind: "cost", cost: 0.5 })
  })

  test("returns 2 when scan_finish succeeds", async () => {
    const result = await executeV2(fakeApi([toolCalled("call_1", "scan_finish"), toolResult("call_1", "success")], [undefined, undefined]), base())

    expect(result.exitCode).toBe(2)
    expect(result.ok).toBe(true)
    expect(result.sawLifecycleFinish).toBe(true)
  })

  test("returns 2 when agent_finish succeeds", async () => {
    const result = await executeV2(fakeApi([toolCalled("call_1", "agent_finish"), toolResult("call_1", "success")], [undefined, undefined]), base())

    expect(result.exitCode).toBe(2)
    expect(result.sawLifecycleFinish).toBe(true)
  })

  test("does not treat a failed lifecycle tool as a finish", async () => {
    const result = await executeV2(fakeApi([toolCalled("call_1", "scan_finish"), toolResult("call_1", "failed")], [undefined, undefined]), base())

    expect(result.exitCode).toBe(0)
    expect(result.sawLifecycleFinish).toBe(false)
  })

  test("ignores lifecycle-looking tools that were never called", async () => {
    const result = await executeV2(fakeApi([toolResult("call_unknown", "success")], [undefined, undefined]), base())

    expect(result.exitCode).toBe(0)
  })

  test("returns 1 when create fails", async () => {
    const api: V2Api = {
      ...fakeApi([], [undefined]),
      create: async () => ({ error: { message: "boom" } }),
    }

    const result = await executeV2(api, base())

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe("boom")
  })

  test("returns 1 when prompt fails", async () => {
    const api: V2Api = {
      ...fakeApi([], [undefined]),
      prompt: async () => ({ error: { message: "nope" } }),
    }

    const result = await executeV2(api, base())

    expect(result.exitCode).toBe(1)
    expect(result.error).toBe("nope")
  })

  test("returns 1 when active polling fails", async () => {
    const api: V2Api = {
      ...fakeApi([], [undefined]),
      active: async () => ({ error: { message: "poll failed" } }),
    }

    const result = await executeV2(api, base())

    expect(result.exitCode).toBe(1)
    expect(result.sawLifecycleFinish).toBe(false)
  })
})

describe("executeV2 idle detection", () => {
  test("exits after the session disappears from active", async () => {
    // First poll sees the session running, later polls do not.
    const result = await executeV2(fakeApi([], [{ ses_abc: {} }, undefined, undefined]), base())

    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
  })

  test("waits for minActivePolls before trusting an absent session", async () => {
    const result = await executeV2(fakeApi([], [undefined, undefined, undefined]), base({ minActivePolls: 3 }))

    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
  })

  test("does not exit early when the session stays active", async () => {
    const api: V2Api = {
      ...fakeApi([], [undefined, { ses_abc: { type: "running" } }]),
      active: async () => ({ data: { ses_abc: { type: "running" } } }),
    }

    const result = await executeV2(api, base({ minActivePolls: 3 }))

    expect(result.exitCode).toBe(1)
    expect(result.error).toBe("stream ended while session was still active")
  })
})

describe("executeV2 event rendering", () => {
  test("renders text, cost, and tool events", async () => {
    const events: RenderEvent[] = []
    await executeV2(
      fakeApi([text("finding"), step(1.25), toolCalled("call_1", "bash"), toolResult("call_1", "success")], [undefined, undefined]),
      base({ onEvent: (e) => events.push(e) }),
    )

    expect(events).toContainEqual({ kind: "text", text: "finding" })
    expect(events).toContainEqual({ kind: "cost", cost: 1.25 })
    expect(events).toContainEqual({ kind: "tool", name: "bash", outcome: "called" })
    expect(events).toContainEqual({ kind: "tool", name: "bash", outcome: "success" })
  })

  test("unwraps nested event payloads", async () => {
    const events: RenderEvent[] = []
    await executeV2(fakeApi([text("nested"), unknown()], [undefined, undefined]), base({ onEvent: (e) => events.push(e) }))

    expect(events).toContainEqual({ kind: "text", text: "nested" })
    expect(events.filter((e) => e.kind === "text")).toHaveLength(1)
  })
})