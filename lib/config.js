/**
 * The plugin's configuration schema.
 *
 * Every field is optional with a working default so a bare `insert` row
 * activates a usable bridge; the patch file only overrides what the user
 * actually wants to change.
 *
 * @module dsh-acp-bridge/config
 */

import Schema from '@deepseek-ai/schemastery'

import { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_PATH } from './constants.js'

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Serve the ACP endpoint. Turning this off keeps the panel and stored settings but refuses connections.'),

  path: Schema.string()
    .default(DEFAULT_PATH)
    .description('Absolute URL prefix for both the ACP endpoints and the panel API.'),

  host: Schema.string()
    .default('127.0.0.1')
    .description('Host recorded in generated client snippets; the listener itself belongs to the Harness web server.'),

  provider: Schema.string()
    .default('')
    .description('Fallback provider route for new sessions when the client has not chosen one.'),

  model: Schema.string()
    .default('')
    .description('Fallback model id for new sessions when the client has not chosen one.'),

  approvalTimeoutMs: Schema.natural()
    .min(1_000)
    .max(3_600_000)
    .default(DEFAULT_APPROVAL_TIMEOUT_MS)
    .description('How long a permission request may wait for an answer before it is rejected.'),

  requireToken: Schema.boolean()
    .default(true)
    .description('Require the generated bearer token on every connection. Disable only on a machine you fully trust.'),

  expose: Schema.object({
    model: Schema.boolean().default(true).description('Advertise the provider/model selector.'),
    reasoning: Schema.boolean()
      .default(true)
      .description('Advertise the reasoning-effort selector when the model declares one.'),
    mode: Schema.boolean()
      .default(true)
      .description('Advertise the agent-preset selector and the legacy modes field.'),
    permission: Schema.boolean().default(true).description('Advertise the approval-policy preset.'),
    commands: Schema.boolean()
      .default(true)
      .description('Publish the Harness slash commands as available_commands.'),
    plan: Schema.boolean().default(true).description('Publish todo/plan progress as plan updates.'),
    usage: Schema.boolean().default(true).description('Publish context occupancy as usage updates.'),
    images: Schema.boolean()
      .default(false)
      .description('Accept inline image prompts. Requires the attachment store and an image-capable route.'),
  }).description('Which capabilities this bridge advertises to clients.'),
})

/**
 * Normalize a route prefix into the exact form the router expects.
 * @param value - configured prefix.
 * @returns a prefix starting and ending with `/`.
 */
export function normalizePrefix(value) {
  const trimmed = (typeof value === 'string' ? value : '').trim()
  if (trimmed.length === 0) return `${DEFAULT_PATH}/`
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

/**
 * Resolve the WebSocket path for a prefix.
 * @param prefix - normalized prefix.
 * @returns the upgrade path.
 */
export function websocketPath(prefix) {
  return `${prefix}ws`
}
