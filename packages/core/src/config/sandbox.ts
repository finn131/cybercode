export * as ConfigSandbox from "./sandbox"

import { Schema } from "effect"

/**
 * Off by default: bash runs with the host user's process and network authority
 * unless this is turned on, and turning it on only helps if a sandbox image has
 * actually been built and pulled.
 *
 * ponytail: one global gate, not per session. AppProcess consumers other than
 * bash (`git`, `ripgrep`) deliberately keep running on the host, so a global
 * switch only reaches the bash tool.
 */
export class Info extends Schema.Class<Info>("ConfigV2.Sandbox")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  image: Schema.String.pipe(Schema.optional),
}) {}