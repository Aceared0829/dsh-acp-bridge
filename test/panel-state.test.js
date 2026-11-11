/**
 * Regression test for the panel payload: it must stay plain, serializable data.
 *
 * A live ACP client context holds a circular reference back to its Connection.
 * Storing one in the panel's connection records made `JSON.stringify` throw, so
 * every panel read returned 500 — caught only by running against a real
 * Harness. This test pins the shape so the mistake cannot come back silently.
 *
 * Run with `node --test test/`.
 *
 * @module dsh-acp-bridge/test/panel-state
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'

/** Records registered routes so the panel handler can be invoked directly. */
function buildContext() {
  const routes = new Map()
  const ctx = {
    logger: { warn: () => undefined },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1234',
      register: (route) => {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => undefined
      },
      registerUpgrade: () => () => undefined,
    },
    agents: { get: () => undefined, create: async () => undefined, resume: async () => undefined },
    llm: {
      listProviders: () => [{ id: 'p', name: 'P' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      resolveCallConfig: async (config) => config,
    },
    sessions: { flush: async () => undefined },
    get: () => undefined,
    on: () => () => undefined,
    effect: (factory) => {
      factory()
      return () => undefined
    },
  }
  return { ctx, routes }
}

const config = {
  enabled: true,
  path: '/dsh-acp-bridge',
  host: '127.0.0.1',
  provider: '',
  model: '',
  approvalTimeoutMs: 60000,
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

/**
 * Invoke one registered route handler and capture its JSON body.
 * @param route - the registered route.
 * @returns the parsed body and status.
 */
async function call(route) {
  let body = ''
  let status = 200
  const res = {
    set statusCode(value) {
      status = value
    },
    get statusCode() {
      return status
    },
    setHeader: () => undefined,
    end: (chunk) => {
      if (typeof chunk === 'string') body += chunk
    },
  }
  await route.handler({ method: 'GET', headers: {}, url: '/dsh-acp-bridge/panel' }, res)
  return { status, body }
}

test('the panel payload is serializable and carries real values', async () => {
  const { ctx, routes } = buildContext()
  plugin.apply(ctx, config)
  const route = routes.get('exact:/dsh-acp-bridge/panel')
  assert.ok(route !== undefined, 'the panel route is registered')

  const { status, body } = await call(route)
  assert.equal(status, 200, `panel must answer 200, got ${status}: ${body}`)

  const state = JSON.parse(body)
  assert.equal(state.enabled, true)
  assert.equal(state.listening, true)
  assert.deepEqual(state.sessions, [])
  assert.deepEqual(state.connections, [])
  assert.equal(typeof state.endpoint, 'string')

  // The launcher must be runnable: no `<port>` placeholder, and an absolute
  // script path rather than a package name nothing has installed globally.
  assert.ok(state.launcher.shell.length > 0)
  assert.ok(!state.launcher.shell.includes('<port>'), 'the snippet must not ship a placeholder')
  assert.ok(state.launcher.command.endsWith('cli.mjs'), 'the shim is addressed by path')
  assert.ok(
    !state.launcher.shell.includes('npx'),
    'a profile install does not put the bin on PATH, so npx would resolve nothing',
  )
  assert.ok(state.launcher.zed.includes('"path"'))

  // Splitting configurations into separate agent entries is the whole point of
  // the per-preset launcher, so a bare entry must still exist for deployments
  // with no presets mounted.
  const parsed = JSON.parse(state.launcher.zed)
  assert.ok(parsed.agent_servers['DSH-Default'] !== undefined, 'a default entry is always offered')
  assert.deepEqual(state.launcher.presets, [], 'no presets when none are mounted')

  // Round-tripping through JSON twice must be stable: proof that nothing
  // circular or class-backed leaked into the payload.
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
})

test('a disabled bridge still answers the panel and reports itself', async () => {
  const { ctx, routes } = buildContext()
  plugin.apply(ctx, { ...config, enabled: false })
  const { status, body } = await call(routes.get('exact:/dsh-acp-bridge/panel'))
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).enabled, false)
})
