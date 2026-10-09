import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_START_TIMEOUT_MS,
  executeV2,
  type RenderEvent,
  type V2Api,
} from "../../src/cli/cmd/run-v2/execute"

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
    const result = await executeV2(fakeApi([text("hi")], [{ ses_abc: {} }, undefined, undefined]), base())

    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
  })

  test("waits for minActivePolls before trusting an absent session", async () => {
    const result = await executeV2(fakeApi([text("hi")], [undefined, undefined, undefined]), base({ minActivePolls: 3 }))

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

// A stream that never yields until it is closed: the shape that used to hang the CLI.
// Closing resolves the pending next() so the consumer loop actually exits.
const hangingApi = (
  active: () => Promise<{ data?: Record<string, unknown>; error?: { message: string } }>,
  onClose?: () => void,
): V2Api => ({
  create: async () => ({ data: { data: { id: "ses_abc" } } }),
  prompt: async () => ({ data: { id: "msg_1" } }),
  events: async () => {
    let closed = false
    let pending: ((result: IteratorResult<{ data?: unknown }>) => void) | undefined
    return {
      stream: {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              if (closed) return Promise.resolve({ done: true as const, value: undefined })
              return new Promise<IteratorResult<{ data?: unknown }>>((resolve) => {
                pending = resolve
              })
            },
            return: async () => {
              closed = true
              onClose?.()
              pending?.({ done: true, value: undefined })
              return { done: true as const, value: undefined }
            },
          }
        },
      } as AsyncIterable<{ data?: unknown }>,
    }
  },
  active: async () => active(),
})

describe("executeV2 wall-clock guard", () => {
  test("defaults to a bounded budget", () => {
    expect(DEFAULT_MAX_DURATION_MS).toBe(30 * 60 * 1000)
    expect(DEFAULT_START_TIMEOUT_MS).toBe(30 * 1000)
  })

  test("waits for a drain that has not registered yet instead of calling it idle", async () => {
    // Absence of `active` right after prompt says nothing: booting the location and
    // its plugin batch outlasts a couple of polls. This used to report a healthy run
    // as "no activity".
    let poll = 0
    const api: V2Api = {
      create: async () => ({ data: { data: { id: "ses_abc" } } }),
      prompt: async () => ({ data: { id: "msg_1" } }),
      events: async () => ({
        stream: (async function* () {
          await new Promise((r) => setTimeout(r, 120))
          yield text("late answer")
          await new Promise((r) => setTimeout(r, 600))
        })(),
      }),
      active: async () => {
        poll += 1
        // Not draining yet, then draining, then finished.
        if (poll < 8) return { data: {} }
        if (poll < 25) return { data: { ses_abc: { type: "running" } } }
        return { data: {} }
      },
    }

    const result = await executeV2(api, base({ pollIntervalMs: 10, minActivePolls: 2, startTimeoutMs: 5_000 }))

    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
  })

  test("exits 1 when the session stays active past the deadline", async () => {
    const result = await executeV2(
      hangingApi(async () => ({ data: { ses_abc: { type: "running" } } })),
      base({ maxDurationMs: 60, pollIntervalMs: 5 }),
    )

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(true)
    expect(result.error).toContain("wall-clock")
  })

  test("exits 1 when create never resolves", async () => {
    const api: V2Api = { ...hangingApi(async () => ({ data: {} })), create: () => new Promise(() => {}) }
    const result = await executeV2(api, base({ maxDurationMs: 60 }))

    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(true)
  })

  test("exits 1 when prompt never resolves", async () => {
    const api: V2Api = { ...hangingApi(async () => ({ data: {} })), prompt: () => new Promise(() => {}) }
    const result = await executeV2(api, base({ maxDurationMs: 60 }))

    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(true)
  })

  test("never treats a timeout as a clean or lifecycle finish", async () => {
    const result = await executeV2(
      hangingApi(async () => ({ data: { ses_abc: { type: "running" } } })),
      base({ maxDurationMs: 60, pollIntervalMs: 5 }),
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode).not.toBe(2)
    expect(result.sawLifecycleFinish).toBe(false)
  })

  test("closes a stream that never ends once the session goes idle", async () => {
    let closed = false
    const result = await executeV2(
      hangingApi(async () => ({ data: {} }), () => {
        closed = true
      }),
      base({ pollIntervalMs: 5, minActivePolls: 2, streamGraceMs: 20, startTimeoutMs: 40 }),
    )

    expect(closed).toBe(true)
    // No events were ever published, so this is a dead run, not a clean finish.
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain("without producing any activity")
  })

  test("surfaces an active() failure as fatal rather than hanging", async () => {
    const result = await executeV2(
      hangingApi(async () => ({ error: { message: "active exploded" } })),
      base({ pollIntervalMs: 5, streamGraceMs: 20, startTimeoutMs: 40 }),
    )

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe("active exploded")
  })
})


// active() empty for every poll, with a controlled event script.
const idleWith = (script: ReadonlyArray<unknown>, polls: number = 6): V2Api => {
  let poll = 0
  return {
    create: async () => ({ data: { data: { id: "ses_abc" } } }),
    prompt: async () => ({ data: { id: "msg_1" } }),
    events: async () => ({
      stream: (async function* () {
        for (const item of script) {
          await sleepMs(1)
          yield item
        }
      })(),
    }),
    active: async () => {
      poll += 1
      return poll <= polls ? { data: {} } : { data: { ses_abc: { type: "running" } } }
    },
  }
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const EV = {
  text: text("done"),
  step: step(0.1),
  toolCalled: toolCalled("call_1", "bash"),
  toolSuccess: toolResult("call_1", "success"),
  noise: unknown(),
}

describe("executeV2 no-activity guard", () => {
  test("1. no events and active() empty immediately -> exit 1", async () => {
    const result = await executeV2(idleWith([], 99), base({ pollIntervalMs: 2, startTimeoutMs: 40 }))

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain("without producing any activity")
    expect(result.sawLifecycleFinish).toBe(false)
  })

  test("2. no events and active() empty through minActivePolls -> exit 1", async () => {
    const result = await executeV2(idleWith([], 99), base({ pollIntervalMs: 2, minActivePolls: 3, startTimeoutMs: 40 }))

    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBeUndefined()
    expect(result.error).toContain("without producing any activity")
  })

  test("3. tool.called then active then idle -> exit 0", async () => {
    const result = await executeV2(idleWith([EV.toolCalled, EV.toolSuccess], 2), base({ pollIntervalMs: 2 }))

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  test("4. text.ended then active then idle -> exit 0", async () => {
    const result = await executeV2(idleWith([EV.text], 2), base({ pollIntervalMs: 2 }))

    expect(result.exitCode).toBe(0)
  })

  test("5. step.ended then active then idle -> exit 0", async () => {
    const result = await executeV2(idleWith([EV.step], 2), base({ pollIntervalMs: 2 }))

    expect(result.exitCode).toBe(0)
  })

  test("6. lifecycle finish still wins over the activity guard -> exit 2", async () => {
    const script = [toolCalled("call_1", "scan_finish"), toolResult("call_1", "success")]
    const result = await executeV2(idleWith(script, 2), base({ pollIntervalMs: 2 }))

    expect(result.exitCode).toBe(2)
    expect(result.sawLifecycleFinish).toBe(true)
  })

  test("7. timeout with no events -> exit 1 and timedOut", async () => {
    const api = hangingApi(async () => ({ data: {} }))
    const result = await executeV2(api, base({ maxDurationMs: 60, pollIntervalMs: 5, minActivePolls: 999 }))

    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(true)
  })

  test("ignores lifecycle noise that does not prove the run executed", async () => {
    const result = await executeV2(idleWith([EV.noise], 99), base({ pollIntervalMs: 2, startTimeoutMs: 40 }))

    expect(result.exitCode).toBe(1)
  })
})
