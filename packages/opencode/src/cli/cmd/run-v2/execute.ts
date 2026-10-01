/**
 * Headless V2 agent run.
 *
 * ponytail: `session.wait` is the right completion signal but it currently always
 * returns 503 (`OperationUnavailableError` in core/src/session.ts), and V2 never
 * publishes the V1 `session.status` idle event. Polling `session.active` is the
 * only working idle signal today; replace with `session.wait` once implemented.
 */

export interface ToolRef {
  readonly callID: string
  readonly name: string
}

export type RenderEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "cost"; readonly cost: number }
  | { readonly kind: "tool"; readonly name: string; readonly outcome: "called" | "success" | "failed" }

/** The slice of the V2 session surface this run needs. Keeps the logic testable. */
export interface V2Api {
  readonly create: (input: {
    agent?: string
    model?: { providerID: string; id: string }
    location?: { directory: string }
  }) => Promise<{ readonly data?: { readonly data?: { readonly id: string } }; readonly error?: { message: string } }>
  readonly prompt: (input: { sessionID: string; prompt: { text: string } }) => Promise<{
    readonly data?: { readonly id: string }
    readonly error?: { message: string }
  }>
  readonly events: (input: { sessionID: string }) => Promise<{ readonly stream: AsyncIterable<{ data?: unknown }> }>
  readonly active: () => Promise<{ readonly data?: Record<string, unknown>; readonly error?: { message: string } }>
}

export interface ExecuteOptions {
  readonly message: string
  readonly directory: string
  readonly agent?: string
  readonly model?: string
  readonly pollIntervalMs?: number
  /** Fail the run if the stream does not show an active session within this many polls. */
  readonly minActivePolls?: number
  readonly onEvent: (event: RenderEvent) => void
}

export interface ExecuteResult {
  readonly ok: boolean
  /** Exit code convention: 0 clean, 1 fatal, 2 a lifecycle tool completed the run. */
  readonly exitCode: number
  readonly sawLifecycleFinish: boolean
  readonly error?: string
}

const LIFECYCLE_TOOLS = new Set(["scan_finish", "agent_finish"])

function splitModel(model: string | undefined): { providerID: string; id: string } | undefined {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}

type DurableEvent = { readonly id?: string; readonly type?: string; readonly data?: Record<string, unknown> }

/**
 * One durable event. The SDK hands over either a decoded `{type, data}` event or
 * an SSE frame `{data: event}`, depending on how the transport nested it.
 */
function unwrap(input: unknown): DurableEvent | undefined {
  if (!input || typeof input !== "object") return undefined
  const payload = input as DurableEvent
  if (typeof payload.type === "string") return payload
  const nested = payload.data
  if (nested && typeof nested === "object" && typeof (nested as DurableEvent).type === "string") {
    return nested as DurableEvent
  }
  return undefined
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function executeV2(api: V2Api, options: ExecuteOptions): Promise<ExecuteResult> {
  const poll = options.pollIntervalMs ?? 500
  const minActivePolls = options.minActivePolls ?? 2
  const model = splitModel(options.model)

  const created = await api.create({
    agent: options.agent,
    model,
    location: { directory: options.directory },
  })
  const sessionID = created.data?.data?.id
  if (!sessionID) return { ok: false, exitCode: 1, sawLifecycleFinish: false, error: created.error?.message ?? "failed to create session" }

  const admitted = await api.prompt({ sessionID, prompt: { text: options.message } })
  if (admitted.error) return { ok: false, exitCode: 1, sawLifecycleFinish: false, error: admitted.error.message }

  // Tool.Called is the only event that names the tool; Tool.Success/Failed carry
  // just the callID, so the name has to be remembered here.
  const names = new Map<string, string>()
  let sawLifecycleFinish = false
  let sawActive = false
  let absentStreak = 0
  let polls = 0
  let streamDone = false

  const eventStream = (await api.events({ sessionID })).stream
  const consume = (async () => {
    try {
      for await (const item of eventStream) {
        const event = unwrap(item)
        if (!event?.type?.startsWith("session.next.")) continue
        const data = (event.data ?? {}) as Record<string, unknown>
        switch (event.type) {
          case "session.next.text.ended": {
            const text = typeof data.text === "string" ? data.text : ""
            if (text) options.onEvent({ kind: "text", text })
            break
          }
          case "session.next.step.ended": {
            const cost = typeof data.cost === "number" ? data.cost : 0
            options.onEvent({ kind: "cost", cost })
            break
          }
          case "session.next.tool.called": {
            const name = typeof data.tool === "string" ? data.tool : "tool"
            const callID = typeof data.callID === "string" ? data.callID : undefined
            if (callID) names.set(callID, name)
            options.onEvent({ kind: "tool", name, outcome: "called" })
            break
          }
          case "session.next.tool.success":
          case "session.next.tool.failed": {
            const callID = typeof data.callID === "string" ? data.callID : undefined
            const name = (callID ? names.get(callID) : undefined) ?? "tool"
            const outcome = event.type === "session.next.tool.success" ? "success" : "failed"
            if (outcome === "success" && LIFECYCLE_TOOLS.has(name)) sawLifecycleFinish = true
            options.onEvent({ kind: "tool", name, outcome })
            break
          }
          default:
            break
        }
      }
    } finally {
      streamDone = true
    }
  })()

  // Exit code 0 clean, 2 a lifecycle tool finished the run.
  const verdict = () => ({ ok: true as const, exitCode: sawLifecycleFinish ? 2 : 0, sawLifecycleFinish })

  let verdictResult: ExecuteResult | undefined
  while (!verdictResult && !streamDone) {
    await sleep(poll)
    polls += 1
    const active = await api.active()
    if (active.error) {
      verdictResult = { ok: false, exitCode: 1, sawLifecycleFinish, error: active.error.message }
      break
    }
    const live = Boolean(active.data && sessionID in active.data)
    if (live) {
      sawActive = true
      absentStreak = 0
      continue
    }
    absentStreak += 1
    if (sawActive || absentStreak >= minActivePolls) verdictResult = verdict()
  }

  // A finite stream ends on its own, so wait for it to drain before deciding.
  if (verdictResult) {
    await consume.catch(() => {})
    return verdictResult
  }

  // No idle verdict: the stream ended while polling kept seeing the session
  // alive, or it ended before the first poll landed.
  await sleep(poll)
  const final = await api.active()
  await consume.catch(() => {})
  if (final.error) return { ok: false, exitCode: 1, sawLifecycleFinish, error: final.error.message }
  if (final.data && sessionID in final.data)
    return { ok: false, exitCode: 1, sawLifecycleFinish, error: "stream ended while session was still active" }
  return verdict()
}