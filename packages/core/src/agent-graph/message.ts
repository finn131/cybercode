export * as AgentMessage from "./message"

import { Effect } from "effect"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"

export const PRIORITY = ["normal", "high"] as const
export type Priority = (typeof PRIORITY)[number]

export const KIND = ["information", "request", "instruction", "result"] as const
export type Kind = (typeof KIND)[number]

export interface SendInput {
  readonly to: SessionSchema.ID
  readonly from: SessionSchema.ID
  readonly fromName: string
  readonly kind: Kind
  readonly priority?: Priority
  readonly text: string
  /** `steer` reaches a running agent now; `queue` waits for it to go idle. */
  readonly delivery?: SessionInput.Delivery
}

export interface Sent {
  readonly messageID: SessionMessage.ID
  readonly delivery: SessionInput.Delivery
}

/**
 * Inter-agent messages ride the same admission path as user prompts: one durable
 * row per message, `promoted_seq` becomes the ack, and nothing is deleted
 * afterwards. A separate mailbox table would collide with the prompt path on the
 * `(session_id, promoted_seq)` uniqueness and its 1:1 message projection.
 *
 * Control characters are dropped rather than escaped so a message body cannot
 * forge the envelope header that precedes it.
 */
export function render(input: SendInput): string {
  const body = Array.from(input.text)
    .filter((char) => {
      const code = char.codePointAt(0)!
      return code >= 0x20 && code !== 0x7f
    })
    .join("")
  return `[Message from ${input.fromName} (${input.from}) | type=${input.kind} | priority=${input.priority ?? "normal"}]\n${body}`
}

export function send(
  prompt: (input: {
    sessionID: SessionSchema.ID
    prompt: { text: string }
    delivery: SessionInput.Delivery
  }) => Effect.Effect<{ readonly id: SessionMessage.ID }, unknown>,
  input: SendInput,
) {
  const delivery = input.delivery ?? "steer"
  return prompt({
    sessionID: input.to,
    prompt: { text: render(input) },
    delivery,
  }).pipe(Effect.map((admitted) => ({ messageID: admitted.id, delivery })))
}