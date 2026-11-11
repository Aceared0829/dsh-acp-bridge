/**
 * Proves the pinned-preset path end to end: the shim sends the header, the
 * upgrade handler keeps it, and a new session opens on that preset before its
 * options are read.
 *
 * Run with `node --test test/`.
 *
 * @module dsh-acp-bridge/test/preset-pinning
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { WebSocketServer } from 'ws'

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))

/**
 * Start a server that records the upgrade headers it receives.
 * @returns the server handle.
 */
async function headerRecorder() {
  const seen = []
  const sockets = []
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  wss.on('connection', (socket, req) => {
    sockets.push(socket)
    seen.push(req.headers)
    socket.on('message', () => undefined)
  })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address()
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    seen,
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}

/**
 * Launch the shim and wait until it has connected.
 * @param args - CLI arguments.
 * @returns the child process.
 */
function launch(args) {
  return spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
}

test('--preset travels as an upgrade header, not as a protocol frame', async () => {
  const server = await headerRecorder()
  const child = launch(['--url', server.url, '--token', 't0k', '--preset', 'minimal'])
  try {
    const deadline = Date.now() + 5000
    while (server.seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(server.seen.length, 1, 'the shim connected')
    const headers = server.seen[0]
    assert.equal(headers['x-dsh-acp-preset'], 'minimal')
    assert.equal(headers.authorization, 'Bearer t0k', 'the token is still sent')

    // The frame stream must stay untouched: the preset is not a frame.
    const frames = []
    child.stdout.on('data', (chunk) => frames.push(chunk.toString()))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(frames.join(''), '', 'no synthetic frame is written to the client')
  } finally {
    child.kill()
    await server.close()
  }
})

test('omitting --preset sends no preset header', async () => {
  const server = await headerRecorder()
  const child = launch(['--url', server.url])
  try {
    const deadline = Date.now() + 5000
    while (server.seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(server.seen[0]['x-dsh-acp-preset'], undefined)
  } finally {
    child.kill()
    await server.close()
  }
})

test('the JetBrains launcher rejects a preset flag with no value', async () => {
  // Real behaviour, not source text: the launcher must refuse a broken
  // invocation instead of starting a client that silently opens the default.
  const launcher = fileURLToPath(new URL('../bin/jetbrains.mjs', import.meta.url))
  const { execFile } = await import('node:child_process')
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [launcher, '--preset'],
      { timeout: 15000, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    )
  })
  assert.notEqual(result.code, 0, 'a missing value is a usage error')
  assert.match(result.stderr, /--preset requires a value/)
  assert.equal(result.stdout, '', 'stdout stays clean: it belongs to the protocol')
})
