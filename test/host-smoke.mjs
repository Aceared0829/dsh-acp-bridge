/**
 * Host smoke test: load the plugin exactly as the Harness would, with a stub
 * Context, and assert that it registers the expected carriers.
 *
 * This is the check that matters for a profile install: it proves every import
 * resolves from inside the profile (the SDK, `ws`, `schemastery`) and that
 * `apply` performs its registrations without touching a live server.
 *
 * Run against the installed copy:
 *   node test/host-smoke.mjs "D:/DSH-Home/profiles/desktop/node_modules/dsh-acp-bridge"
 *
 * @module dsh-acp-bridge/test/host-smoke
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const target = process.argv[2]
const entry =
  target === undefined
    ? new URL('../lib/index.js', import.meta.url).href
    : pathToFileURL(`${target.replace(/\/+$/, '')}/lib/index.js`).href
const plugin = await import(entry)

assert.equal(plugin.name, 'acp-bridge', 'plugin name')
assert.deepEqual(
  [...plugin.inject].sort(),
  ['agents', 'llm', 'sessions', 'webServer'],
  'declared inject list',
)
assert.equal(typeof plugin.apply, 'function', 'apply is exported')
assert.ok(plugin.Config !== undefined, 'Config schema is exported')

/** Records everything `apply` registers, in order. */
const routes = []
const upgrades = []
const listeners = []
const effects = []

/** A Context stub exposing just what this plugin touches. */
const ctx = {
  logger: { warn: (...args) => console.warn('[warn]', ...args) },
  webServer: {
    getOrigin: () => 'http://127.0.0.1:1234',
    register: (route) => {
      routes.push(route)
      return () => undefined
    },
    registerUpgrade: (route) => {
      upgrades.push(route)
      return () => undefined
    },
  },
  agents: { get: () => undefined, create: async () => undefined, resume: async () => undefined },
  llm: {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => ({}),
    resolveCallConfig: async (config) => config,
  },
  sessions: { flush: async () => undefined },
  get: () => undefined,
  on: (event, handler) => {
    listeners.push(event)
    return () => undefined
  },
  effect: (factory) => {
    effects.push(factory)
    const disposer = factory()
    return () => disposer?.()
  },
}

const config = {
  enabled: true,
  path: '/dsh-acp-bridge',
  host: '127.0.0.1',
  provider: '',
  model: '',
  approvalTimeoutMs: 60000,
  // Token auth off so this smoke test never writes to the user's home dir.
  requireToken: false,
  expose: {
    model: true,
    reasoning: true,
    mode: true,
    permission: true,
    commands: true,
    plan: true,
    usage: true,
    images: false,
  },
}

plugin.apply(ctx, config)

assert.ok(routes.length >= 3, `expected at least 3 HTTP routes, got ${routes.length}`)
const paths = routes.map((route) => `${route.kind}:${route.path}`)
assert.ok(paths.includes('prefix:/dsh-acp-bridge/'), `carrier route missing in ${paths.join(', ')}`)
assert.ok(paths.includes('exact:/dsh-acp-bridge/panel'), 'panel route missing')
assert.ok(paths.includes('exact:/dsh-acp-bridge/action'), 'action route missing')

assert.equal(upgrades.length, 1, 'one WebSocket upgrade route')
assert.equal(upgrades[0].path, '/dsh-acp-bridge/ws')

for (const event of ['session/event', 'agent/inbox/claimed', 'agent/error', 'llm/adapters-updated', 'approval/request']) {
  assert.ok(listeners.includes(event), `missing listener for ${event}`)
}

assert.equal(effects.length, 1, 'one disposal effect')
console.log(`host-smoke: ok — ${routes.length} routes, ${upgrades.length} upgrade, ${listeners.length} listeners`)
