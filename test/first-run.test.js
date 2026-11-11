/**
 * Tests for the two behaviours a first-run install depends on: an unconfigured
 * route follows the Harness default model, and a model-less session still
 * advertises the options that do not need one.
 *
 * Run with `node --test test/`.
 *
 * @module dsh-acp-bridge/test/first-run
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AcpModelControl } from '../lib/model-control.js'

/**
 * A logger that records what it was told.
 * @returns the logger and its lines.
 */
function spyLogger() {
  const lines = []
  return { lines, warn: (message) => lines.push(message) }
}

/** The smallest agent the projection reads. */
function agentWithoutModel() {
  return {
    id: 's1',
    status: 'idle',
    session: { id: 's1', header: { id: 's1' }, seq: 0 },
    model: { current: () => undefined, select: () => undefined },
  }
}

test('a session without a model still offers the approval selector', async () => {
  const agentPresets = {
    list: async () => [
      { id: 'default', name: 'Default', isDefault: true },
      { id: 'super-code', name: 'Super code' },
    ],
    presetForSession: () => null,
    select: async () => 'default',
  }
  const approval = { overrideOf: () => undefined, setPolicy: () => undefined }
  const logger = spyLogger()
  const control = new AcpModelControl(
    { llm: {}, agentPresets, approval, logger },
    agentWithoutModel(),
    { model: true, reasoning: true, mode: true, permission: true },
  )
  const options = await control.options()
  assert.deepEqual(
    options.map((option) => option.id),
    ['_dsh_permission'],
    'the model selector is honestly absent, approvals still work, and the ' +
      'mode selector stays out because presets are chosen by client entry',
  )
  assert.equal(
    logger.lines.length,
    1,
    'and the deployment problem is reported rather than swallowed',
  )
  assert.match(logger.lines[0], /no model selection/)
})

test('a model-less session with those options disabled reports nothing', async () => {
  const control = new AcpModelControl({ llm: {} }, agentWithoutModel(), {
    model: true,
    reasoning: true,
    mode: false,
    permission: false,
  })
  assert.deepEqual(await control.options(), [])
})

test('a session with a model does not log the missing-selection warning', async () => {
  const logger = spyLogger()
  const agent = {
    id: 's1',
    status: 'idle',
    session: { id: 's1', header: { id: 's1' }, seq: 0 },
    model: { current: () => ({ provider: 'p', model: 'm' }), select: () => undefined },
  }
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ provider: 'p', id: 'm', name: 'M' }],
    resolveModelInfo: async () => ({ provider: 'p', model: 'm', id: 'm', name: 'M' }),
    resolveCallConfig: async (config) => config,
  }
  const control = new AcpModelControl({ llm, logger }, agent, {
    model: true,
    reasoning: true,
    mode: false,
    permission: false,
  })
  const options = await control.options()
  assert.equal(options[0].id, 'model')
  assert.deepEqual(logger.lines, [])
})
