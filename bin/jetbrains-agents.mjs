#!/usr/bin/env node
/**
 * Print ready-to-paste JetBrains agent entries, one per agent preset.
 *
 * JetBrains lists agents from `~/.jetbrains/acp.json`, one entry per agent, and
 * an entry is just a command. Pinning `--preset` per entry is what turns each
 * DeepSeek Harness configuration into its own row instead of one row with a
 * mode menu that the IDE reads as permission tiers.
 *
 * Usage:
 *   node bin/jetbrains-agents.mjs [--origin http://127.0.0.1:PORT] [--merge]
 *
 * @module dsh-acp-bridge/jetbrains-agents
 */

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_DIR = join(homedir(), '.dsh', 'acp-bridge')
const TOKEN_FILE = join(STATE_DIR, 'token')
const CONFIG_FILE = join(homedir(), '.jetbrains', 'acp.json')
const LAUNCHER = fileURLToPath(new URL('./jetbrains.mjs', import.meta.url))
const PANEL_PATH = '/dsh-acp-bridge/panel'

function fail(message) {
  process.stderr.write(`dsh-acp-jetbrains-agents: ${message}\n`)
  process.exit(2)
}

function readToken() {
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (token.length >= 16) return token
  } catch {
    // Reported below.
  }
  fail(`no access token at ${TOKEN_FILE}. Open the ACP panel in DeepSeek Harness once.`)
}

function execText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout))
    })
  })
}

/** Find the port the running Harness serves the bridge on. */
async function discoverPort(token) {
  const tasklist = await execText('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'])
  const pids = new Set()
  for (const line of tasklist.split(/\r?\n/)) {
    const match = line.match(/"DeepSeek Harness.exe","(\d+)"/i)
    if (match) pids.add(match[1])
  }
  if (pids.size === 0) fail('DeepSeek Harness is not running.')
  const netstat = await execText('netstat', ['-ano', '-p', 'tcp'])
  const candidates = []
  for (const line of netstat.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (!match || !pids.has(match[3])) continue
    if (/^(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\])$/.test(match[1])) candidates.push(Number(match[2]))
  }
  for (const port of candidates) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${PANEL_PATH}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(700),
      })
      if (response.status === 200) return port
    } catch {
      // Try the next candidate.
    }
  }
  fail('the ACP bridge is not listening. Open the panel in DeepSeek Harness and enable it.')
}

const token = readToken()
const argv = process.argv.slice(2)
const originFlag = argv.indexOf('--origin')
const merge = argv.includes('--merge')
const port = originFlag === -1 ? await discoverPort(token) : undefined
const origin = originFlag === -1 ? `http://127.0.0.1:${port}` : argv[originFlag + 1]

// The roster is the bridge's own answer, so the generated entries cannot drift
// from what the deployment actually offers.
let presets
try {
  const response = await fetch(`${origin}/dsh-acp-bridge/panel`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  })
  const state = await response.json()
  presets = state.launcher?.presets ?? []
} catch (error) {
  fail(`cannot read the preset roster from ${origin}: ${error.message}`)
}
if (!Array.isArray(presets) || presets.length === 0) {
  fail('the bridge reported no agent presets, so there is nothing to split.')
}

const agentServers = {}
for (const preset of presets) {
  // Plain ASCII hyphen and no separator glyph: editor config files are not
  // always read as UTF-8, and a mangled name is what the user sees in the
  // agent list.
  agentServers[`DSH-${preset.name}`] = {
    command: process.execPath,
    args: [LAUNCHER, '--preset', preset.id],
    env: {},
  }
}
const generated = { agent_servers: agentServers }

if (!merge) {
  process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`)
  process.exit(0)
}

let current = { agent_servers: {} }
try {
  current = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
} catch {
  // No file yet, or unreadable: start from the generated set.
}
const merged = {
  ...current,
  agent_servers: { ...(current.agent_servers ?? {}), ...agentServers },
}
writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

process.stderr.write(
  `dsh-acp-jetbrains-agents: wrote ${Object.keys(agentServers).length} entries to ${CONFIG_FILE}\n`,
)
