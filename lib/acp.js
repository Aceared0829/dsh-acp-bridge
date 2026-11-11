/**
 * Shared protocol-facing helpers and the option ids this bridge advertises.
 *
 * Everything here is deliberately free of Cordis and DSH imports so the module
 * can be unit-tested by plain `node --test` without a Harness in the process.
 *
 * @module dsh-acp-bridge/acp
 */

/** Standard ACP selector: provider + model route. */
export const MODEL_OPTION = 'model'
/** Standard ACP selector: reasoning effort on the current model. */
export const REASONING_OPTION = 'reasoning_effort'
/** Standard ACP selector: the session's agent preset. */
export const MODE_OPTION = 'mode'
/** Extension selector: the approval policy preset. */
export const PERMISSION_OPTION = '_dsh_permission'
/** Extension selector: whether inline image prompts are advertised. */
export const IMAGE_OPTION = '_dsh_image_input'

/**
 * Sentinel value for "let the adapter decide the reasoning effort".
 * ACP select values are strings, so absence needs a token.
 */
export const PROVIDER_DEFAULT_EFFORT = ''

/**
 * Encode an opaque selector value. Callers must round-trip it verbatim, so it
 * carries the complete identity rather than a display string.
 * @param provider - provider route.
 * @param model - exact model id.
 * @returns the wire value.
 */
export function modelValue(provider, model) {
  return JSON.stringify([provider, model])
}

/**
 * Decode a selector value produced by {@link modelValue}.
 * @param value - wire value.
 * @returns the pair, or `undefined` when the value was not produced by us.
 */
export function parseModelValue(value) {
  if (typeof value !== 'string') return undefined
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
  const [provider, model] = parsed
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

/**
 * A failure the caller can correct: reported to the client as `-32602`.
 * Anything else becomes `-32603`.
 */
export class AcpInvalidParams extends Error {
  /**
   * @param message - protocol-safe detail, never raw binary or secrets.
   */
  constructor(message) {
    super(message)
    this.name = 'AcpInvalidParams'
  }
}

/**
 * Map a Harness turn ending onto ACP's terminal vocabulary.
 * @param reason - `turn/end` payload.
 * @returns the closest legal stop reason.
 */
export function turnEndToStopReason(reason) {
  switch (reason?.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'interrupted':
      return 'cancelled'
    case 'aborted':
      // A user stop is a cancellation; an abort caused by anything else still
      // ends the turn without an error for the client.
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/**
 * Read a canonical base64 payload without accepting aliases.
 * @param value - candidate wire string.
 * @returns whether it is canonical base64.
 */
export function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false
  }
  return Buffer.from(value, 'base64').toString('base64') === value
}

/**
 * Pin a new ACP session's approval policy before it is advertised.
 *
 * The Harness default can be `never`, which would make the panel-answer and
 * timeout path unreachable: tools are rejected without ever asking. A new ACP
 * session therefore records `ask` directly on the session log. `setPolicy` is
 * the wrong call here — it also injects a "the user changed the policy"
 * message into the inbox, and this session has not started a turn yet.
 *
 * Resumed sessions are left alone: their recorded policy is the user's.
 *
 * @param session - the fresh session.
 * @param approval - the approval service, when mounted.
 * @param policy - `ask`, `never`, or `inherit` to keep the Harness default.
 * @returns whether a policy record was appended.
 */
export function pinApprovalPolicy(session, approval, policy) {
  if (policy !== 'ask' && policy !== 'never') return false
  if (approval === undefined || typeof session?.append !== 'function') return false
  const current =
    typeof approval.effectivePolicy === 'function'
      ? approval.effectivePolicy(session)
      : (approval.overrideOf?.(session) ?? 'ask')
  if (current === policy) return false
  session.append('approval/policy', { policy })
  return true
}

/**
 * Clamp an unbounded value into a safe integer range.
 * @param value - candidate number.
 * @param fallback - value to use when the candidate is unusable.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the clamped value.
 */
export function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}
