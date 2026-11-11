/**
 * dsh-acp-bridge — serve this Harness's agents over the Agent Client Protocol.
 *
 * The Host half owns one `AcpServer` from the official ACP SDK and exposes it
 * on two carriers: a WebSocket upgrade (used by the stdio shim that editors
 * spawn, and by any client that can open a socket) and Streamable HTTP (used by
 * clients that speak it directly). Nothing here re-implements the protocol — the
 * SDK validates params and shapes responses, and `AcpSession` translates between
 * ACP and the Harness services.
 *
 * @module dsh-acp-bridge
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { agent } from '@agentclientprotocol/sdk'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import { WebSocketServer } from 'ws'

import { pinApprovalPolicy } from './acp.js'
import { Config, normalizePrefix, websocketPath } from './config.js'
import { AcpSession } from './session.js'

/** Cordis plugin name. */
export const name = 'acp-bridge'

/** Services this plugin cannot work without. */
export const inject = ['webServer', 'agents', 'llm', 'sessions']

/** Where the persisted access token lives. */
const STATE_DIR = join(homedir(), '.dsh', 'acp-bridge')
const TOKEN_FILE = join(STATE_DIR, 'token')

/** Identity reported to clients during `initialize`. */
const IMPLEMENTATION = { name: 'deepseek-harness-acp-bridge', version: '0.1.0' }

/** How many desensitized frames the panel keeps. */
const TRAFFIC_LIMIT = 500

/** Upper bound for one request body, in bytes. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * Read the persisted access token, minting one on first use.
 * @returns the token.
 */
function ensureToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
      if (existing.length >= 16) return existing
    }
  } catch {
    // A lost or unreadable token only invalidates generated scripts.
  }
  const token = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  } catch (error) {
    throw new Error(`acp-bridge: cannot persist the access token in ${STATE_DIR}: ${error.message}`)
  }
  return token
}

/**
 * Resolve the route a new session should start on.
 *
 * An empty plugin config must not produce a model-less Agent: the ACP client
 * would then be offered no `model` option at all, and the session could not
 * run a turn. The order is the plugin's own configuration, then the Harness's
 * own default model, so an unconfigured install behaves like a normal new
 * session in the app.
 *
 * @param ctx - Host context.
 * @param config - plugin configuration.
 * @returns provider/model fields to apply, omitting the ones nothing supplied.
 */
function resolveRoute(ctx, config) {
  if (config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (fallback !== undefined && fallback !== null && typeof fallback.provider === 'string') {
    return { provider: fallback.provider, model: fallback.model }
  }
  return {}
}

/**
 * Mount the ACP bridge.
 * @param ctx - Cordis context carrying the Harness services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const prefix = normalizePrefix(config.path)
  const wsPath = websocketPath(prefix)
  const expose = { ...config.expose }
  const token = config.requireToken ? ensureToken() : undefined
  const approvalTimeoutMs = config.approvalTimeoutMs

  /** Local connection records the panel lists. */
  const connections = new Map()
  /**
   * Live ACP client contexts, keyed by connection id. Kept out of the panel's
   * connection records because these objects hold a circular reference to the
   * transport and cannot be serialized.
   */
  const liveClients = new Map()
  /**
   * Agent preset pinned per connection, from the `x-dsh-acp-preset` upgrade
   * header. One editor entry per preset is how each configuration gets its own
   * row in the client's agent list.
   */
  const connectionPresets = new Map()
  /** Live ACP sessions, keyed by ACP session id. */
  const sessions = new Map()
  /** Recent desensitized frames, newest last. */
  const traffic = []
  /** Permission requests waiting for a panel answer. */
  const approvals = new Map()

  let closed = false

  /**
   * Append one desensitized frame to the traffic ring.
   * @param direction - `in` for client to agent, `out` for the reverse.
   * @param method - protocol method or a short event name.
   * @param detail - safe, short detail.
   */
  const record = (direction, method, detail) => {
    traffic.push({ at: Date.now(), direction, method, detail })
    if (traffic.length > TRAFFIC_LIMIT) traffic.shift()
  }

  /** Reject work after disposal. */
  const assertOpen = () => {
    if (closed) throw new Error('the ACP bridge has been disposed')
  }

  /**
   * Build the agent-side app that owns one accepted connection.
   *
   * Each connection gets its own app so a disconnect tears down exactly the
   * sessions that client created, and so two editors cannot observe each
   * other's updates.
   * @returns the ACP agent app.
   */
  const createAgentApp = () => {
    const app = agent({ name: IMPLEMENTATION.name })
    const state = {
      connectionId: undefined,
      client: undefined,
      // The connection's abort signal. `connection.client` is only the
      // request/notify context and has no `signal`; reading `.aborted` there
      // throws and fails the whole assistant delivery.
      signal: undefined,
      clientLabel: 'ACP client',
      imageEnabled: false,
    }

    /** Publish one update to this connection, tolerating a closed socket. */
    const notify = async (sessionId, update) => {
      const client = state.client
      if (client === undefined || state.signal?.aborted === true) return
      record('out', update.sessionUpdate ?? 'update', sessionId)
      try {
        await client.notify('session/update', { sessionId, update })
      } catch {
        // A vanished client must not fail the Agent's turn.
      }
    }

    const sessionDeps = () => ({
      ctx,
      notify,
      expose,
      approvalTimeoutMs,
      onEvent: (event) => {
        if (event.kind === 'approval') approvals.set(event.id, event)
        else if (event.kind === 'approval-cleared') approvals.delete(event.id)
      },
    })

    /** Look up a live session owned by this connection or fail. */
    const requireSession = (sessionId) => {
      const record_ = sessions.get(sessionId)
      if (record_ === undefined) throw new Error(`unknown session: ${sessionId}`)
      return record_
    }

    /** Publish a session and stamp it with its owning connection. */
    const adopt = (record_) => {
      record_.connectionId = state.connectionId
      sessions.set(record_.id, record_)
    }

    app.onConnect((connection) => {
      state.connectionId = randomUUID()
      state.client = connection.client
      state.signal = connection.signal
      state.clientLabel = describeClient(connection)
      // Only plain data goes into the registry: the ACP context object holds a
      // circular reference to its Connection, so storing it here would make the
      // panel unserializable and keep a dead transport alive. The live handle
      // lives on `state` instead, which is scoped to this connection.
      connections.set(state.connectionId, {
        id: state.connectionId,
        openedAt: Date.now(),
        client: state.clientLabel,
      })
      liveClients.set(state.connectionId, connection.client)
      record('in', 'connect', state.connectionId)

      // Forget the connection once it closes, so the panel and the approval
      // routing never address a socket that is already gone.
      connection.closed
        .catch(() => undefined)
        .then(() => {
          connections.delete(state.connectionId)
          liveClients.delete(state.connectionId)
          connectionPresets.delete(state.connectionId)
          approvals.clear()
          record('out', 'disconnect', state.connectionId)
        })
    })

    app.onRequest('initialize', async ({ params }) => {
      state.imageEnabled = await imagesUsable(ctx, expose.images, config)
      return {
        protocolVersion: params.protocolVersion,
        agentInfo: IMPLEMENTATION,
        agentCapabilities: {
          promptCapabilities: { image: state.imageEnabled, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
        },
        authMethods: [],
      }
    })

    app.onRequest('authenticate', async () => ({}))

    app.onRequest('session/new', async ({ params, signal }) => {
      assertOpen()
      record('in', 'session/new', params.cwd)
      const sessionId = randomUUID()
      const record_ = await AcpSession.create(sessionDeps(), {
        sessionId,
        cwd: params.cwd,
        agentOptions: resolveRoute(ctx, config),
        signal,
      })
      adopt(record_)
      try {
        pinApprovalPolicy(record_.agent.session, ctx.get('approval'), config.approvalPolicy)
        // Apply the connection's pinned preset before the roster is read, so a
        // client that launched as DSH-Minimal opens in that configuration and
        // never sees a mode selector it would have to drive first.
        const pinned = connectionPresets.get(state.connectionId)
        if (pinned !== undefined) await record_.applyPreset(pinned, signal)
        const configOptions = await record_.configOptions(signal)
        const modes = await record_.modes()
        return {
          sessionId,
          configOptions,
          ...(modes === undefined ? {} : { modes }),
          _meta: { dshAcpBridge: { connectionId: state.connectionId } },
        }
      } catch (error) {
        sessions.delete(sessionId)
        await record_.close('session/new activation failed')
        throw error
      }
    })

    app.onRequest('session/resume', async ({ params, signal }) => {
      assertOpen()
      if (sessions.has(params.sessionId)) {
        throw new Error(`session is already active: ${params.sessionId}`)
      }
      const record_ = await AcpSession.resume(sessionDeps(), {
        sessionId: params.sessionId,
        agentOptions: resolveRoute(ctx, config),
        signal,
      })
      adopt(record_)
      try {
        const configOptions = await record_.configOptions(signal)
        const modes = await record_.modes()
        return { configOptions, ...(modes === undefined ? {} : { modes }) }
      } catch (error) {
        sessions.delete(params.sessionId)
        await record_.close('session/resume option discovery failed')
        throw error
      }
    })

    app.onRequest('session/list', async ({ signal }) => {
      assertOpen()
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return { sessions: [] }
      const listed = await persistence.list({ signal })
      return {
        sessions: listed
          .filter(({ header }) => header.origin !== 'subagent' && typeof header.cwd === 'string')
          .map(({ header }) => ({ sessionId: header.id, cwd: header.cwd })),
      }
    })

    app.onRequest('session/delete', async ({ params }) => {
      assertOpen()
      const record_ = sessions.get(params.sessionId)
      if (record_ !== undefined) {
        sessions.delete(params.sessionId)
        await record_.close('ACP session deleted')
      }
      return {}
    })

    app.onRequest('session/close', async ({ params }) => {
      assertOpen()
      const record_ = sessions.get(params.sessionId)
      if (record_ === undefined) return {}
      sessions.delete(params.sessionId)
      await record_.close('ACP session closed')
      return {}
    })

    app.onRequest('session/set_config_option', async ({ params, signal }) => {
      assertOpen()
      const record_ = requireSession(params.sessionId)
      return { configOptions: await record_.setConfig(params.configId, params.value, signal) }
    })

    app.onRequest('session/set_mode', async ({ params, signal }) => {
      assertOpen()
      const record_ = requireSession(params.sessionId)
      await record_.setMode(params.modeId, signal)
      return {}
    })

    app.onRequest('session/prompt', async ({ params, signal }) => {
      assertOpen()
      record('in', 'session/prompt', params.sessionId)
      return requireSession(params.sessionId).prompt(params, state.imageEnabled, signal)
    })

    app.onNotification('session/cancel', ({ params }) => {
      sessions.get(params.sessionId)?.cancel()
    })

    return app
  }

  // ---- Carriers -------------------------------------------------------------

  const acpServer = new AcpServer({ createAgent: createAgentApp })

  const disposeHttp = ctx.webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      if (!config.enabled) {
        res.statusCode = 503
        res.end('ACP bridge is disabled')
        return
      }
      if (!authorize(req, token)) {
        res.statusCode = 401
        res.setHeader('www-authenticate', 'Bearer')
        res.end('unauthorized')
        return
      }
      const url = `${ctx.webServer.getOrigin()}${req.url ?? prefix}`
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req)
      const response = await acpServer.handleRequest(
        new Request(url, {
          method: req.method,
          headers: toHeaders(req.headers),
          ...(body === undefined ? {} : { body }),
        }),
      )
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      res.end(Buffer.from(await response.arrayBuffer()))
    },
  })

  // The ACP WebSocket carrier speaks JSON-RPC text frames, so it needs its own
  // true upgrade path rather than the panel's JSON route. `ws` owns framing and
  // the SDK's prepared connection carries `Acp-Connection-Id` on the 101.
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', () => {
    record('in', 'upgrade', 'websocket accepted')
  })

  const disposeUpgrade = ctx.webServer.registerUpgrade({
    path: wsPath,
    handler: (req, socket, head) => {
      if (!config.enabled) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
        return
      }
      if (!authorize(req, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const prepared = acpServer.prepareWebSocketUpgrade()
      // A client entry may pin one preset for the sessions it creates, which is
      // what lets an editor list DSH-Standard and DSH-Minimal as separate
      // agents instead of one agent with a mode menu.
      const requestedPreset = presetFrom(req)
      wss.handleUpgrade(req, socket, head, (ws) => {
        const connection = prepared.accept(ws)
        if (requestedPreset !== undefined) connectionPresets.set(prepared.connectionId, requestedPreset)
        record('in', 'upgrade', prepared.connectionId)
      })
    },
  })

  // ---- Panel API -------------------------------------------------------------

  const disposePanel = ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}panel`,
    handler: async (req, res) => {
      if (!authorize(req, token)) {
        res.statusCode = 401
        res.end('unauthorized')
        return
      }
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      try {
        const state = await panelState()
        res.end(JSON.stringify(state))
      } catch (error) {
        // Surface the real cause: a serialization bug here once read as an
        // opaque 500 because the message alone hid which field was at fault.
        ctx.logger?.warn?.(`acp-bridge: panel state failed: ${error?.stack ?? error}`)
        res.statusCode = 500
        res.end(JSON.stringify({ error: error?.message ?? String(error) }))
      }
    },
  })

  const disposeAction = ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}action`,
    handler: async (req, res) => {
      if (!authorize(req, token) || req.method !== 'POST') {
        res.statusCode = 401
        res.end('unauthorized')
        return
      }
      res.setHeader('content-type', 'application/json; charset=utf-8')
      let payload = {}
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        payload = {}
      }
      try {
        res.end(JSON.stringify(await act(payload)))
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }))
      }
    },
  })

  /** Read the panel's complete view. */
  async function panelState() {
    const presets = ctx.get('agentPresets')
    const rows = []
    for (const record_ of sessions.values()) {
      const selection = record_.agent.model.current()
      rows.push({
        sessionId: record_.id,
        connectionId: record_.connectionId ?? '',
        cwd: record_.agent.session.header.cwd ?? '',
        mode: presets?.presetForSession(record_.agent.session) ?? '',
        provider: selection?.provider ?? '',
        model: selection?.model ?? '',
        effort: selection?.reasoningEffort === undefined ? '' : String(selection.reasoningEffort),
        state:
          record_.pendingApprovalView() !== undefined
            ? 'waiting'
            : record_.agent.status === 'running'
              ? 'running'
              : 'idle',
      })
    }
    const origin = safeOrigin(ctx)
    return {
      enabled: config.enabled,
      listening: !closed,
      endpoint: `${origin}${prefix}`,
      websocket: `${origin.replace(/^http/, 'ws')}${wsPath}`,
      token: token ?? '',
      connections: [...connections.values()],
      sessions: rows,
      approvals: [...approvals.values()],
      expose,
      traffic: traffic.slice(-100),
      launcher: launcherSnippet(origin, wsPath, token, await presetRoster(presets)),
    }
  }

  /**
   * Run one panel action.
   * @param payload - the action envelope.
   * @returns a serializable result.
   */
  async function act(payload) {
    const action = payload?.action
    if (action === 'kick') {
      const record_ = sessions.get(payload.sessionId)
      if (record_ === undefined) return { ok: false, error: 'unknown session' }
      sessions.delete(payload.sessionId)
      await record_.close('disconnected from the Harness panel')
      return { ok: true }
    }
    if (action === 'approve' || action === 'reject') {
      const record_ = sessions.get(payload.sessionId)
      if (record_ === undefined) return { ok: false, error: 'unknown session' }
      const answered = record_.answerPendingApproval(action === 'approve')
      return answered ? { ok: true } : { ok: false, error: 'nothing pending' }
    }
    if (action === 'rotate-token') {
      if (token === undefined) return { ok: false, error: 'token authentication is disabled' }
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(TOKEN_FILE, `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, {
        mode: 0o600,
      })
      return { ok: true, note: 'Restart the profile to load the new token.' }
    }
    return { ok: false, error: `unknown action: ${action}` }
  }

  // ---- Harness event fan-out -------------------------------------------------

  /** The session module that owns a session id, if any. */
  const owner = (sessionId) => sessions.get(sessionId)

  ctx.on('session/event', (session, event) => {
    const record_ = owner(session.header.id)
    if (record_ !== undefined) record_.onSessionEvent(session, event)
  })

  ctx.on('agent/inbox/claimed', ({ agent: claimed, message, turn }) => {
    owner(claimed.id)?.onInboxClaimed(message, turn)
  })

  ctx.on('agent/error', ({ agent: failed, error }) => {
    owner(failed.id)?.onAgentError(error)
  })

  ctx.on('llm/adapters-updated', () => {
    for (const record_ of sessions.values()) {
      void record_
        .configOptions()
        .then((configOptions) => record_.enqueue({ sessionUpdate: 'config_option_update', configOptions }))
        .catch(() => undefined)
    }
  })

  // Ask the client first; when it cannot answer, park the request for the panel.
  ctx.on('approval/request', async (request, next) => {
    const record_ = sessions.get(request.agent.id)
    if (record_ === undefined || request.callId === undefined) return next()

    await record_.drainUpdates()

    // The live handle belongs to the connection that created the session; a
    // client that has since disconnected cannot answer, so this falls straight
    // through to the panel.
    const client = liveClientOf(record_)
    if (client === undefined) return parkForPanel(record_, request)

    let outcome
    try {
      const response = await client.request('session/request_permission', {
        sessionId: record_.id,
        toolCall: { toolCallId: request.callId, title: request.toolName },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      })
      outcome = response.outcome
    } catch {
      outcome = { outcome: 'cancelled' }
    }
    if (outcome.outcome === 'cancelled') return parkForPanel(record_, request)
    return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
  })

  /**
   * Resolve the live ACP client context that owns one session.
   * @param record_ - the session module.
   * @returns the context, or `undefined` when its connection is gone.
   */
  function liveClientOf(record_) {
    const connectionId = record_.connectionId ?? ''
    if (connectionId.length === 0) return undefined
    const handle = liveClients.get(connectionId)
    // Presence in the map is the liveness check. The stored value is the
    // client context, which has no abort signal; the map entry is removed
    // when `connection.closed` settles.
    if (handle === undefined) return undefined
    return handle
  }

  /**
   * Hold one approval until the panel answers or the timeout rejects it.
   * @param record_ - the owning session.
   * @param request - the approval request.
   * @returns the eventual outcome.
   */
  function parkForPanel(record_, request) {
    return new Promise((resolve) => {
      record_.holdApproval(request, (outcome) => resolve(outcome))
    })
  }

  ctx.effect(
    () => () => {
      closed = true
      sessions.clear()
      connections.clear()
      liveClients.clear()
      connectionPresets.clear()
      approvals.clear()
      disposeHttp()
      disposeUpgrade()
      disposePanel()
      disposeAction()
      for (const client of wss.clients) client.close(1001, 'bridge disposed')
      wss.close()
      void acpServer.close().catch(() => undefined)
    },
    'acp-bridge: carriers',
  )
}

/**
 * Read a client's declared identity for the panel.
 *
 * initialize may report clientInfo; older clients do not, so the label has
 * to degrade to something honest rather than showing undefined.
 *
 * @param connection - the ACP connection handle.
 * @returns a short label.
 */
function describeClient(connection) {
  const info = connection?.clientInfo ?? connection?.initializeResult?.clientInfo
  if (info === undefined || info === null) return 'ACP client'
  return info.title ?? info.name ?? 'ACP client'
}

/**
 * Read the server origin without throwing before the listener binds.
 * @param ctx - Host context.
 * @returns the origin, or an empty string.
 */

function safeOrigin(ctx) {
  try {
    return ctx.webServer.getOrigin()
  } catch {
    return ''
  }
}

/**
 * Whether an image prompt can be admitted on this deployment.
 * @param ctx - Host context.
 * @param wanted - whether configuration enables image prompts.
 * @param config - plugin configuration.
 * @returns whether `initialize` may advertise images.
 */
async function imagesUsable(ctx, wanted, config) {
  if (!wanted) return false
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  if (attachments === undefined || llm === undefined) return false
  if (config.provider.length === 0 || config.model.length === 0) return false
  try {
    const info = await llm.resolveModelInfo(config.provider, config.model)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/** Build the Agent route options from configuration, omitting empty fields. */
/**
 * Check the bearer token on one request.
 * @param req - the incoming request.
 * @param token - the expected token, or `undefined` when auth is off.
 * @returns whether the request may proceed.
 */
function authorize(req, token) {
  if (token === undefined) return true
  const header = req.headers.authorization ?? ''
  const value = Array.isArray(header) ? header[0] : header
  if (!value.toLowerCase().startsWith('bearer ')) return false
  return value.slice(7).trim() === token
}

/**
 * Read the preset a client pinned for its sessions.
 *
 * One editor entry per preset is how each Harness configuration gets its own
 * row in the client's agent list, so the choice has to survive the upgrade.
 * An unknown id is ignored here and reported when a session is created, where
 * the roster is available to say what the valid ids are.
 *
 * @param req - the WebSocket upgrade request.
 * @returns the pinned preset id, or `undefined`.
 */
function presetFrom(req) {
  const raw = req.headers['x-dsh-acp-preset']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Convert node headers into a `Headers` instance.
 * @param headers - node incoming headers.
 * @returns the fetch headers.
 */
function toHeaders(headers) {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    result.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return result
}

/**
 * Read a request body as UTF-8 text.
 * @param req - the incoming request.
 * @returns the body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Render the snippet a user pastes into their client configuration.
 *
 * The shim is invoked through its absolute path, not a package name: a profile
 * install links this package but does not put its `bin` on PATH, and nothing
 * here should assume the user has published or installed it globally. The
 * real port is baked in, because a snippet with a placeholder in it is a
 * snippet the user has to debug before it can work.
 *
 * @param baseUrl - the live HTTP origin, e.g. `http://127.0.0.1:56979`.
 * @param wsPath - the WebSocket path.
 * @param token - the bearer token, when required.
 * @returns the snippet text.
 */
function launcherSnippet(baseUrl, wsPath, token, presets) {
  const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}${wsPath}`
  const args = [cli, '--url', wsUrl, ...(token === undefined ? [] : ['--token', token])]
  const quote = (value) => (value.includes(' ') ? `"${value}"` : value)
  // One client entry per preset, so each configuration is its own agent
  // instead of a menu inside one agent.
  const perPreset = (presets ?? []).map((preset) => ({
    id: preset.id,
    label: preset.label,
    args: [...args, '--preset', preset.id],
  }))
  return {
    command: cli,
    url: wsUrl,
    presets: presets ?? [],
    shell: [process.execPath, ...args].map(quote).join(' '),
    zed: JSON.stringify(
      {
        // A bare entry always exists: it is what works when presets are not
        // mounted, and it is a valid target even when they are.
        // Labels stay ASCII: a config file is not always decoded as UTF-8.
        agent_servers: {
          'DSH-Default': { command: { path: process.execPath, args } },
          ...Object.fromEntries(
            perPreset.map((entry) => [
              entry.label,
              { command: { path: process.execPath, args: entry.args } },
            ]),
          ),
        },
      },
      null,
      2,
    ),
  }
}

/**
 * Read the preset roster for the launcher without failing the panel.
 * @param presets - the agent preset registry, when mounted.
 * @returns id/label pairs, newest default first.
 */
async function presetRoster(presets) {
  if (presets === undefined) return []
  let roster
  try {
    roster = await presets.list()
  } catch {
    return []
  }
  if (!Array.isArray(roster)) return []
  return roster
    .filter((preset) => preset.broken === undefined)
    .map((preset) => ({
      id: preset.id,
      name: preset.name ?? preset.id,
      label: preset.name ?? preset.id,
    }))
}

export { Config }
