/**
 * Values shared by the Host half and the panel.
 * @module dsh-acp-bridge/constants
 */

/** How many desensitized frames the traffic pane keeps. */
export const DEFAULT_TRAFFIC_FRAMES = 500

/** Default route prefix owned by this plugin. */
export const DEFAULT_PATH = '/dsh-acp-bridge'

/** How long an unanswered approval waits before it is rejected. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000
