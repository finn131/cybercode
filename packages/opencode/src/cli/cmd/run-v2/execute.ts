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
  /**
   * Hard budget for the whole lifecycle: create, prompt, stream consumption and
   * idle polling. Exceeding it is fatal, never a clean finish.
   */
  readonly maxDurationMs?: number
  /** How long to wait for the event stream to settle once a verdict is reached. */
  readonly streamGraceMs?: number
  /**
   * How long to wait for the drain to visibly start before calling the run dead.
   * A session that produced nothing and never appears in `active` is a failed run,
   * but absence alone proves nothing until the drain has had a chance to register.
   */
  readonly startTimeoutMs?: number
  readonly onEvent: (event: RenderEvent) => void
}

export interface ExecuteResult {
  readonly ok: boolean
  /** Exit code convention: 0 clean, 1 fatal, 2 a lifecycle tool completed the run. */
  readonly exitCode: number
  readonly sawLifecycleFinish: boolean
  readonly error?: string
  /** True when the run was cut short by the wall-clock budget, not by an error. */
  readonly timedOut?: boolean
}

export const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000
/** Startup budget before a run that never registered is declared dead. */
export const DEFAULT_START_TIMEOUT_MS = 30 * 1000

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

type ActiveResult = { readonly data?: Record<string, unknown>; readonly error?: { message: string } }

/** Signals the wall-clock budget ran out. Always fatal. */
class WallClockExceeded extends Error {
  constructor(readonly budgetMs: number) {
    super(`run exceeded wall-clock budget of ${Math.round(budgetMs / 1000)}s`)
    this.name = "WallClockExceeded"
  }
}

const isWallClock = (error: unknown) => error instanceof WallClockExceeded

export async function executeV2(api: V2Api, options: ExecuteOptions): Promise<ExecuteResult> {
  const poll = options.pollIntervalMs ?? 500
  const minActivePolls = options.minActivePolls ?? 2
  const maxDuration = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  const grace = options.streamGraceMs ?? 2_000
  const startTimeout = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const startedAt = Date.now()
  const deadlineAt = startedAt + maxDuration
  const remaining = () => deadlineAt - Date.now()

  /** Bound any blocking await by whatever is left of the budget. */
  const guard = <T>(work: Promise<T>): Promise<T> => {
    const left = remaining()
    if (left <= 0) return Promise.reject(new WallClockExceeded(maxDuration))
    return Promise.race([work, sleep(left).then(() => Promise.reject(new WallClockExceeded(maxDuration)))])
  }

  const fatal = (error: unknown) => ({
    ok: false,
    exitCode: 1,
    sawLifecycleFinish: false,
    error: isWallClock(error) ? error.message : error instanceof Error ? error.message : String(error),
    ...(isWallClock(error) ? { timedOut: true } : {}),
  })

  const model = splitModel(options.model)

  let created: Awaited<ReturnType<V2Api["create"]>>
  try {
    created = await guard(
      api.create({
        agent: options.agent,
        model,
        location: { directory: options.directory },
      }),
    )
  } catch (error) {
    return fatal(error)
  }
  const sessionID = created.data?.data?.id
  if (!sessionID)
    return { ok: false, exitCode: 1, sawLifecycleFinish: false, error: created.error?.message ?? "failed to create session" }

  let admitted: Awaited<ReturnType<V2Api["prompt"]>>
  try {
    admitted = await guard(api.prompt({ sessionID, prompt: { text: options.message } }))
  } catch (error) {
    return fatal(error)
  }
  if (admitted.error) return { ok: false, exitCode: 1, sawLifecycleFinish: false, error: admitted.error.message }

  // Tool.Called is the only event that names the tool; Tool.Success/Failed carry
  // just the callID, so the name has to be remembered here.
  const names = new Map<string, string>()
  let sawLifecycleFinish = false
  /**
   * Any event proving the session actually ran. `active() == empty` alone cannot
   * distinguish "finished" from "the drain died before publishing anything", and
   * treating the latter as success is a false positive on a headless CLI.
   */
  let observedActivity = false
  let sawActive = false
  let absentStreak = 0
  let streamDone = false
  // Held so the SSE socket can be closed on any exit path; a stream left open
  // keeps the event loop alive and the CLI never returns.
  let closeStream: (() => void) | undefined

  let eventStream: AsyncIterable<{ data?: unknown }>
  try {
    eventStream = (await guard(api.events({ sessionID }))).stream
  } catch (error) {
    return fatal(error)
  }
  const iterator = eventStream[Symbol.asyncIterator]()
  closeStream = () => {
    void Promise.resolve(iterator.return?.(undefined)).catch(() => {})
  }

  const consume = (async () => {
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        const item = next.value
        const event = unwrap(item)
        if (!event?.type?.startsWith("session.next.")) continue
        const data = (event.data ?? {}) as Record<string, unknown>
        switch (event.type) {
          case "session.next.text.ended": {
            observedActivity = true
            const text = typeof data.text === "string" ? data.text : ""
            if (text) options.onEvent({ kind: "text", text })
            break
          }
          case "session.next.step.ended": {
            observedActivity = true
            const cost = typeof data.cost === "number" ? data.cost : 0
            options.onEvent({ kind: "cost", cost })
            break
          }
          case "session.next.tool.called": {
            observedActivity = true
            const name = typeof data.tool === "string" ? data.tool : "tool"
            const callID = typeof data.callID === "string" ? data.callID : undefined
            if (callID) names.set(callID, name)
            options.onEvent({ kind: "tool", name, outcome: "called" })
            break
          }
          case "session.next.tool.success":
          case "session.next.tool.failed": {
            observedActivity = true
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

  // Exit code 0 clean, 2 a lifecycle tool finished the run. Idle with no observed
  // activity is fatal: the drain died before publishing anything, and reporting
  // that as a clean finish would be a false positive on a headless CLI.
  const verdict = (): ExecuteResult => {
    if (sawLifecycleFinish) return { ok: true, exitCode: 2, sawLifecycleFinish }
    if (!observedActivity)
      return {
        ok: false,
        exitCode: 1,
        sawLifecycleFinish,
        error: "session went idle without producing any activity",
      }
    return { ok: true, exitCode: 0, sawLifecycleFinish }
  }

  let verdictResult: ExecuteResult | undefined
  while (!verdictResult && !streamDone) {
    if (remaining() <= 0) {
      verdictResult = fatal(new WallClockExceeded(maxDuration))
      break
    }
    await sleep(Math.min(poll, remaining()))
    if (remaining() <= 0) {
      verdictResult = fatal(new WallClockExceeded(maxDuration))
      break
    }
    const active: ActiveResult = await api.active().catch((error: unknown): ActiveResult => ({
      error: { message: isWallClock(error) ? error.message : String(error) },
    }))
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
    // Absent before the drain ever registered proves nothing: booting the location
    // and its plugin batch outlast a couple of polls, so scoring that as finished
    // reports a healthy run as a failure. Wait for a real start first.
    if (sawActive || (observedActivity && absentStreak >= minActivePolls)) {
      verdictResult = verdict()
      continue
    }
    if (!observedActivity && Date.now() - startedAt >= startTimeout) verdictResult = verdict()
  }

  // Close the SSE socket and give the consumer a bounded grace window so events
  // already in flight still render. Never wait unbounded on it.
  closeStream()
  await Promise.race([consume.catch(() => {}), sleep(Math.min(grace, Math.max(remaining(), 0)))])

  if (verdictResult) return verdictResult

  // No idle verdict and the loop only exits because the stream ended: the last
  // active check decides whether that is acceptable.
  const final: ActiveResult = await api.active().catch((error: unknown): ActiveResult => ({
    error: { message: isWallClock(error) ? error.message : String(error) },
  }))
  if (final.error) return { ok: false, exitCode: 1, sawLifecycleFinish, error: final.error.message }
  if (final.data && sessionID in final.data)
    return { ok: false, exitCode: 1, sawLifecycleFinish, error: "stream ended while session was still active" }
  return verdict()
}