#!/usr/bin/env node
/**
 * Stable entry JetBrains launches.
 *
 * The IDE can only start a command. The Harness web port changes on every
 * restart, so this process finds the live bridge, then replaces itself with
 * the stdio shim. Nothing is written to stdout: that stream belongs to ACP.
 *
 * @module dsh-acp-bridge/jetbrains
 */

import { spawn, execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_DIR = join(homedir(), '.dsh', 'acp-bridge')
const TOKEN_FILE = join(STATE_DIR, 'token')
const ENDPOINT_FILE = join(STATE_DIR, 'endpoint')
const SHIM = fileURLToPath(new URL('./cli.mjs', import.meta.url))
const PANEL_PATH = '/dsh-acp-bridge/panel'
const WS_PATH = '/dsh-acp-bridge/ws'

/** Diagnostics only. stdout is the ACP stream. */
function note(message) {
  process.stderr.write(`dsh-acp-jetbrains: ${message}\n`)
}

function fail(message) {
  note(message)
  process.exit(2)
}

function readToken() {
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (token.length >= 16) return token
  } catch {
    // Reported below.
  }
  fail(`no access token at ${TOKEN_FILE}. Open the ACP panel in DeepSeek Harness once, then retry.`)
}

/** Ports the plugin last advertised, tried before a process scan. */
function hintedPorts() {
  try {
    const text = readFileSync(ENDPOINT_FILE, 'utf8').trim()
    const match = text.match(/:(\d+)(?:\/|$)/)
    return match ? [Number(match[1])] : []
  } catch {
    return []
  }
}

function execText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout))
    })
  })
}

/** Listening loopback ports owned by a running DeepSeek Harness. */
async function harnessPorts() {
  const tasklist = await execText('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'])
  const pids = new Set()
  for (const line of tasklist.split(/\r?\n/)) {
    const match = line.match(/"DeepSeek Harness.exe","(\d+)"/i)
    if (match) pids.add(match[1])
  }
  if (pids.size === 0) return []
  const netstat = await execText('netstat', ['-ano', '-p', 'tcp'])
  const ports = new Set(hintedPorts())
  for (const line of netstat.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (!match || !pids.has(match[3])) continue
    const host = match[1]
    if (host === '127.0.0.1' || host === '0.0.0.0' || host === '[::]' || host === '[::1]') {
      ports.add(Number(match[2]))
    }
  }
  return [...ports]
}

/** Whether this port is the bridge, not some other local service. */
async function isBridge(port, token) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 700)
  try {
    const response = await fetch(`http://127.0.0.1:${port}${PANEL_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    return response.status === 200
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read `--preset <id>` from this launcher's own arguments.
 *
 * The editor points one entry per preset here, so the id has to reach the
 * shim as a connect header. Args are parsed before anything touches the
 * network, because an unknown flag must not start a socket.
 * @param argv - arguments after the script name.
 * @returns the preset id, or `undefined`.
 */
function readPresetArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--preset') {
      const value = argv[index + 1]
      if (value === undefined) fail('--preset requires a value')
      return value
    }
    if (arg.startsWith('--preset=')) {
      const value = arg.slice('--preset='.length)
      if (value.length === 0) fail('--preset requires a value')
      return value
    }
  }
  return undefined
}

const preset = readPresetArg(process.argv.slice(2))
const token = readToken()
const ports = await harnessPorts()
let port
for (const candidate of ports) {
  if (await isBridge(candidate, token)) {
    port = candidate
    break
  }
}
if (port === undefined) {
  fail('DeepSeek Harness is not running, or its ACP bridge is not listening. Start the desktop app and retry.')
}

const url = `ws://127.0.0.1:${port}${WS_PATH}`
note(preset === undefined ? `connecting to ${url}` : `connecting to ${url} as agent preset "${preset}"`)
const shimArgs = [SHIM, '--url', url, '--token', token, ...(preset === undefined ? [] : ['--preset', preset])]
const child = spawn(process.execPath, shimArgs, {
  stdio: 'inherit',
  windowsHide: true,
  env: process.env,
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
child.on('error', (error) => fail(error.message))
