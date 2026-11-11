/**
 * Shim test: spawn the real `bin/cli.mjs`, point it at a real WebSocket server,
 * and prove that stdin frames reach the socket and socket frames reach stdout
 * byte-for-byte.
 *
 * The shim is the piece an editor actually launches, and it must not alter a
 * frame, so this asserts on exact payloads rather than on parsed JSON.
 *
 * Run with `node --test test/`.
 *
 * @module dsh-acp-bridge/test/shim
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { WebSocketServer } from 'ws'

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))

/**
 * Start a WebSocket server that records frames and can push its own.
 * @param options - auth token and an optional greeting frame.
 * @returns the server handle.
 */
async function startWs(options = {}) {
  const received = []
  const sockets = []
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info, done) => {
      if (options.token === undefined) return done(true)
      const header = info.req.headers.authorization ?? ''
      done(header === `Bearer ${options.token}`)
    },
  })
  wss.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      received.push(data.toString())
      if (options.greet !== undefined && received.length === 1) {
        socket.send(options.greet)
      }
    })
  })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address()
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    received,
    sockets,
    push: (text) => sockets.at(-1)?.send(text),
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}

/**
 * Launch the shim and collect its streams.
 * @param args - CLI arguments.
 * @returns the child, plus promises for its stdout and exit.
 */
function launch(args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  return {
    child,
    exited,
    out: () => stdout,
    err: () => stderr,
    /** Wait until a predicate over stdout holds, or fail on timeout. */
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate(stdout)) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`timed out; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)
    },
  }
}

test('frames cross the shim in both directions without being rewritten', async () => {
  const server = await startWs()
  const shim = launch(['--url', server.url])
  try {
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    shim.child.stdin.write(`${request}\n`)
    await shim.waitFor(() => server.received.length === 1)
    assert.equal(server.received[0], request, 'stdin frame reaches the socket verbatim')

    const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    server.push(response)
    await shim.waitFor((out) => out.includes('"ok":true'))
    assert.equal(shim.out().trim(), response, 'socket frame reaches stdout verbatim and alone')
  } finally {
    shim.child.kill()
    await shim.exited
    await server.close()
  }
})

test('the bearer token is sent on the upgrade', async () => {
  const server = await startWs({ token: 'secret-token' })
  const shim = launch(['--url', server.url, '--token', 'secret-token'])
  try {
    shim.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
    await shim.waitFor(() => server.received.length === 1)
    assert.equal(server.received.length, 1, 'an authorized upgrade forwards frames')
  } finally {
    shim.child.kill()
    await shim.exited
    await server.close()
  }
})

test('a rejected upgrade exits non-zero and reports on stderr', async () => {
  const server = await startWs({ token: 'right-token' })
  const shim = launch(['--url', server.url, '--token', 'wrong-token'])
  try {
    const code = await shim.exited
    assert.notEqual(code, 0, 'a refused upgrade is a failure')
    assert.match(shim.err(), /connection closed|401|error/i)
    assert.equal(shim.out(), '', 'stdout stays clean: it belongs to the protocol')
  } finally {
    await server.close()
  }
})

test('a missing --url is a usage error, not a silent no-op', async () => {
  const shim = launch([])
  const code = await shim.exited
  assert.equal(code, 2)
  assert.match(shim.err(), /--url/)
  assert.equal(shim.out(), '')
})

test('closing stdin closes the socket cleanly', async () => {
  const server = await startWs()
  const shim = launch(['--url', server.url])
  try {
    shim.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
    await shim.waitFor(() => server.received.length === 1)
    shim.child.stdin.end()
    const code = await shim.exited
    assert.equal(code, 0, 'a normal shutdown is success')
  } finally {
    await server.close()
  }
})
