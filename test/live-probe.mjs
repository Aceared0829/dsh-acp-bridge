/**
 * Live probe: drive the running Harness's ACP endpoint exactly as an editor
 * would — spawn the real shim, speak ACP over it, create a session, and read
 * the config options the Harness actually advertises.
 *
 * Usage:
 *   node test/live-probe.mjs <ws-url> <token>
 *
 * This talks to a real Harness, so it asserts on shape rather than on values:
 * the model list and preset roster are whatever the deployment has.
 *
 * @module dsh-acp-bridge/test/live-probe
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const [url, token] = process.argv.slice(2)
if (url === undefined) {
  console.error('usage: node test/live-probe.mjs <ws-url> <token>')
  process.exit(2)
}

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))

// Start the shim the way an editor does, then speak JSON-RPC to it on stdio.
const shim = spawn(process.execPath, [CLI, '--url', url, ...(token ? ['--token', token] : [])], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
shim.stderr.on('data', (chunk) => process.stderr.write(`[shim] ${chunk}`))

const lines = createInterface({ input: shim.stdout, crlfDelay: Infinity })
const pending = new Map()
let nextId = 1
const notified = []

lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    console.error(`non-JSON on stdout: ${line}`)
    return
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
    return
  }
  notified.push(message)
})

/**
 * Send one JSON-RPC request and await its response.
 * @param method - protocol method.
 * @param params - request params.
 * @returns the result.
 */
function request(method, params) {
  const id = nextId++
  shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`))
    }, 30_000)
  })
}

/** Answer client-side requests that arrive as notifications in this probe. */
const fail = (detail) => {
  console.error(`FAIL ${detail}`)
  shim.kill()
  process.exit(1)
}
const ok = (detail) => console.log(`ok   ${detail}`)

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  })
  ok(`initialize → ${init.agentInfo.name} ${init.agentInfo.version}`)
  const caps = init.agentCapabilities ?? {}
  ok(`session capabilities: ${Object.keys(caps.sessionCapabilities ?? {}).join(', ') || 'none'}`)

  const session = await request('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  })
  ok(`session/new → ${session.sessionId}`)
  if (typeof session.sessionId !== 'string' || session.sessionId.length === 0) {
    fail('session/new returned no session id')
  }

  const options = session.configOptions ?? []
  ok(`configOptions: ${options.map((option) => `${option.id}(${option.category ?? '-'})`).join(', ') || 'none'}`)

  const model = options.find((option) => option.id === 'model')
  if (model === undefined) fail('no model option was advertised')
  const groups = model.options ?? []
  const names = groups.flatMap((group) => (group.options ?? []).map((entry) => entry.name))
  ok(`model choices: ${names.length} across ${groups.length} provider group(s)`)
  if (names.length === 0) fail('the model selector offered no choices')

  const reasoning = options.find((option) => option.id === 'reasoning_effort')
  if (reasoning !== undefined) {
    ok(`reasoning_effort: current=${JSON.stringify(reasoning.currentValue)} choices=${reasoning.options.length}`)
  } else {
    ok('reasoning_effort: not advertised for the current model')
  }

  const mode = options.find((option) => option.id === 'mode')
  if (mode !== undefined) {
    ok(`mode: current=${mode.currentValue} choices=${mode.options.map((entry) => entry.value).join('|')}`)
  } else {
    ok('mode: not advertised (no presets mounted)')
  }
  if (session.modes !== undefined) {
    ok(`legacy modes: current=${session.modes.currentModeId} (${session.modes.availableModes.length})`)
  }

  const permission = options.find((option) => option.id === '_dsh_permission')
  if (permission !== undefined) {
    ok(`_dsh_permission: current=${permission.currentValue}`)
  }

  // Switching the model must return the complete resulting state.
  if (names.length > 1) {
    const target = groups
      .flatMap((group) => group.options ?? [])
      .find((entry) => entry.value !== model.currentValue)
    const changed = await request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'model',
      value: target.value,
    })
    const after = (changed.configOptions ?? []).find((option) => option.id === 'model')
    ok(`set_config_option(model) → current is now ${target.name}`)
    if (after?.currentValue !== target.value) fail('the resulting state did not report the new model')
  }

  await request('session/close', { sessionId: session.sessionId })
  ok('session/close → clean')
  console.log('\nLIVE PROBE PASSED')
} catch (error) {
  fail(error.message)
} finally {
  shim.kill()
}
