/**
 * Verify one JetBrains-style launch: start the launcher with a preset, speak
 * ACP, and confirm the created session reports that preset. This is the path
 * the IDE takes for every row in its agent list.
 *
 * Usage: node test/preset-launch.mjs <presetId>
 *
 * @module dsh-acp-bridge/test/preset-launch
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const preset = process.argv[2]
if (preset === undefined) {
  console.error('usage: node test/preset-launch.mjs <presetId>')
  process.exit(2)
}

const LAUNCHER = fileURLToPath(new URL('../bin/jetbrains.mjs', import.meta.url))
const child = spawn(process.execPath, [LAUNCHER, '--preset', preset], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (chunk) => process.stderr.write(`[launcher] ${chunk}`))

const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
const pending = new Map()
let nextId = 1
lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  }
})

function request(method, params) {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.delete(id) && reject(new Error(`${method} timed out`)), 30000)
  })
}

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const session = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
  const mode = (session.configOptions ?? []).find((option) => option.id === 'mode')
  const permission = (session.configOptions ?? []).find((option) => option.id === '_dsh_permission')
  const labels = (mode?.options ?? []).map((option) => option.name).join(', ')
  console.log(
    JSON.stringify({
      requested: preset,
      opened: mode?.currentValue,
      matched: mode?.currentValue === preset,
      legacy: session.modes?.currentModeId,
      permission: permission?.currentValue,
      labels,
    }),
  )
  await request('session/close', { sessionId: session.sessionId })
} catch (error) {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
} finally {
  child.kill()
}
