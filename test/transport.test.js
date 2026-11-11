/**
 * End-to-end transport test: start the SDK's ACP server behind a real HTTP
 * listener, connect a real WebSocket client, and drive the initialize and
 * session-setup handshake. This exercises the same `AcpServer` calls the plugin
 * makes, so a regression there fails here rather than in an editor.
 *
 * Run with `node --test test/`.
 *
 * @module dsh-acp-bridge/test/transport
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { agent, client } from '@agentclientprotocol/sdk'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'
import { WebSocket, WebSocketServer } from 'ws'

/**
 * Stand up a server that speaks ACP over a WebSocket upgrade, mirroring the
 * plugin's carrier wiring: prepare before the 101, then accept.
 * @param buildApp - builds the agent app per connection.
 * @returns the server handle and its URL.
 */
async function startServer(buildApp) {
  const acpServer = new AcpServer({ createAgent: buildApp })
  const wss = new WebSocketServer({ noServer: true })
  const http = createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  http.on('upgrade', (req, socket, head) => {
    const prepared = acpServer.prepareWebSocketUpgrade()
    wss.handleUpgrade(req, socket, head, (ws) => prepared.accept(ws))
  })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address()
  return {
    url: `ws://127.0.0.1:${port}/acp`,
    async close() {
      for (const socket of wss.clients) socket.terminate()
      wss.close()
      await acpServer.close().catch(() => undefined)
      await new Promise((resolve) => http.close(resolve))
    },
  }
}

/** The agent app the plugin registers, reduced to what the handshake touches. */
function probeApp() {
  const app = agent({ name: 'probe-agent' })
  app.onRequest('initialize', async ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentInfo: { name: 'probe', version: '0.0.0' },
    agentCapabilities: {
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
    },
    authMethods: [],
  }))
  app.onRequest('authenticate', async () => ({}))
  app.onRequest('session/new', async () => ({
    sessionId: 'session-probe',
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: JSON.stringify(['provider', 'model-a']),
        options: [
          {
            group: 'provider',
            name: 'Provider',
            options: [
              { value: JSON.stringify(['provider', 'model-a']), name: 'Model A' },
              { value: JSON.stringify(['provider', 'model-b']), name: 'Model B' },
            ],
          },
        ],
      },
    ],
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'super-code', name: 'Super code' },
      ],
    },
    _meta: { dshAcpBridge: { connectionId: 'c1' } },
  }))
  app.onRequest('session/list', async () => ({ sessions: [] }))
  app.onRequest('session/close', async () => ({}))
  app.onRequest('session/set_config_option', async () => ({
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: JSON.stringify(['provider', 'model-b']),
        options: [{ value: JSON.stringify(['provider', 'model-b']), name: 'Model B' }],
      },
    ],
  }))
  return app
}

test('a client completes the handshake and receives session options', async () => {
  const server = await startServer(probeApp)
  try {
    const clientApp = client({ name: 'probe-client' })
    clientApp.onRequest('session/request_permission', async () => ({
      outcome: { outcome: 'cancelled' },
    }))

    const stream = createWebSocketStream(server.url, { WebSocket })
    const summary = await clientApp.connectWith(stream, async (ctx) => {
      const init = await ctx.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      assert.equal(init.agentInfo.name, 'probe')
      assert.ok(init.agentCapabilities.sessionCapabilities.list, 'session/list is advertised')

      const session = await ctx.request('session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      })
      assert.equal(session.sessionId, 'session-probe')
      assert.equal(session.configOptions.length, 1)
      assert.equal(session.configOptions[0].category, 'model')
      assert.equal(session.modes.currentModeId, 'default')
      assert.deepEqual(
        session.modes.availableModes.map((mode) => mode.id),
        ['default', 'super-code'],
      )

      const changed = await ctx.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'model',
        value: JSON.stringify(['provider', 'model-b']),
      })
      assert.equal(changed.configOptions[0].currentValue, JSON.stringify(['provider', 'model-b']))

      await ctx.request('session/close', { sessionId: session.sessionId })
      return session.sessionId
    })

    assert.equal(summary, 'session-probe')
  } finally {
    await server.close()
  }
})

test('an HTTP refusal surfaces as a failed handshake, not a hang', async () => {
  const http = createServer((_req, res) => {
    res.statusCode = 401
    res.setHeader('www-authenticate', 'Bearer')
    res.end('unauthorized')
  })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address()
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/acp`)
    const failure = await new Promise((resolve) => {
      socket.on('unexpected-response', (_req, res) => resolve(new Error(`HTTP ${res.statusCode}`)))
      socket.on('error', (error) => resolve(error))
      socket.on('open', () => resolve(null))
    })
    assert.ok(failure !== null, 'the handshake must not succeed')
    socket.terminate()
  } finally {
    await new Promise((resolve) => http.close(resolve))
  }
})
