#!/usr/bin/env node
/**
 * dsh-acp-stdio — the stdio shim an ACP client spawns.
 *
 * ACP v1 defines exactly one transport: the client starts a subprocess and both
 * sides exchange newline-delimited JSON-RPC on stdin/stdout. Editors therefore
 * can only launch a command; they cannot dial a port. This shim is that command.
 *
 * It is deliberately protocol-agnostic: it reads NDJSON frames from stdin and
 * forwards them verbatim over one WebSocket, then writes the frames it receives
 * back to stdout. It never parses or rewrites a message, so it cannot drift from
 * the protocol the bridge speaks.
 *
 * Anything printed to stdout must be a valid ACP frame; diagnostics go to stderr.
 *
 * Usage:
 *   dsh-acp-stdio --url ws://127.0.0.1:PORT/dsh-acp-bridge/ws --token TOKEN
 *
 * @module dsh-acp-stdio
 */

import { createInterface } from 'node:readline'
import process from 'node:process'

import { WebSocket } from 'ws'

/** Frame buffered because the socket was not writable yet. */
const pending = []

/** Exit with a usage diagnostic. stderr only: stdout belongs to the protocol. */
function fail(message) {
  process.stderr.write(`dsh-acp-stdio: ${message}\n`)
  process.exit(2)
}

const USAGE = `dsh-acp-stdio — connect an ACP client's stdio to a running DeepSeek Harness.

Usage:
  dsh-acp-stdio --url <ws-url> [--token <token>] [--insecure]

Reads newline-delimited JSON-RPC on stdin, forwards each frame over the given
WebSocket, and writes the frames it receives back to stdout. Point an ACP client
at this command; the only argument it needs is the URL the Harness panel shows.
`

/**
 * Resolve CLI arguments into a connection target.
 * @param argv - process arguments after the script name.
 * @returns the parsed options.
 */
function parseArgs(argv) {
  const options = { url: undefined, token: undefined, insecure: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--insecure') {
      options.insecure = true
    } else if (arg === '--url' || arg === '--token') {
      const value = argv[index + 1]
      if (value === undefined) fail(`${arg} requires a value`)
      options[arg.slice(2)] = value
      index += 1
    } else if (arg.startsWith('--url=')) {
      options.url = arg.slice('--url='.length)
    } else if (arg.startsWith('--token=')) {
      options.token = arg.slice('--token='.length)
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stderr.write(USAGE)
  process.exit(0)
}
if (options.url === undefined) {
  process.stderr.write(USAGE)
  fail('--url is required')
}
if (!/^wss?:\/\//.test(options.url)) {
  fail(`--url must be a ws:// or wss:// URL, got ${options.url}`)
}
if (options.token === undefined && !options.insecure) {
  // Not fatal: the bridge may have token authentication disabled.
  process.stderr.write('dsh-acp-stdio: no --token given; connecting unauthenticated\n')
}

const socket = new WebSocket(options.url, {
  ...(options.token === undefined ? {} : { headers: { authorization: `Bearer ${options.token}` } }),
})

let stdinStarted = false

/** Start the stdin pump exactly once, after the socket accepts frames. */
function startStdin() {
  if (stdinStarted) return
  stdinStarted = true
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    const frame = line.trim()
    if (frame.length === 0) return
    if (socket.readyState === WebSocket.OPEN) socket.send(frame)
    else pending.push(frame)
  })
  lines.on('close', () => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'stdin closed')
    else process.exit(0)
  })
}

socket.on('open', () => {
  process.stderr.write(`dsh-acp-stdio: connected to ${options.url}\n`)
  while (pending.length > 0) socket.send(pending.shift())
  startStdin()
})

socket.on('message', (data, isBinary) => {
  const text = isBinary ? data.toString('utf8') : data.toString()
  process.stdout.write(`${text}\n`)
})

socket.on('close', (code) => {
  process.stderr.write(`dsh-acp-stdio: connection closed (${code})\n`)
  process.exit(code === 1000 ? 0 : 1)
})

socket.on('error', (error) => {
  process.stderr.write(`dsh-acp-stdio: ${error.message}\n`)
})

process.stdout.on('error', (error) => {
  // The client went away, so there is nothing left to write.
  process.stderr.write(`dsh-acp-stdio: stdout closed (${error.code ?? error.message})\n`)
  process.exit(0)
})

// A SIGTERM from the editor should close the socket cleanly so the bridge can
// release the sessions this client owned.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'client terminated')
    else process.exit(0)
  })
}
