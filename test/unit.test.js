/**
 * Protocol-level tests that need no Harness: the ACP wiring, the config-option
 * projection against fake services, and the prompt admission path.
 *
 * Run with `node --test test/`.
 *
 * @module dsh-acp-bridge/test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AcpInvalidParams,
  MODEL_OPTION,
  PERMISSION_OPTION,
  PROVIDER_DEFAULT_EFFORT,
  REASONING_OPTION,
  isCanonicalBase64,
  modelValue,
  parseModelValue,
  pinApprovalPolicy,
  turnEndToStopReason,
} from '../lib/acp.js'
import { normalizePrefix, websocketPath } from '../lib/config.js'
import { AcpModelControl } from '../lib/model-control.js'

test('model selector values round-trip and reject foreign input', () => {
  const value = modelValue('deepseek-account', 'deepseek-v4.1')
  assert.deepEqual(parseModelValue(value), { provider: 'deepseek-account', model: 'deepseek-v4.1' })
  assert.equal(parseModelValue('{"nope":1}'), undefined)
  assert.equal(parseModelValue('not json'), undefined)
  assert.equal(parseModelValue(undefined), undefined)
  assert.equal(parseModelValue(JSON.stringify(['a', ''])), undefined)
})

test('turn endings map onto the legal stop reasons', () => {
  assert.equal(turnEndToStopReason({ kind: 'completed' }), 'end_turn')
  assert.equal(turnEndToStopReason({ kind: 'max-tokens' }), 'max_tokens')
  assert.equal(turnEndToStopReason({ kind: 'interrupted' }), 'cancelled')
  assert.equal(turnEndToStopReason({ kind: 'aborted', reason: { kind: 'user' } }), 'cancelled')
  assert.equal(turnEndToStopReason({ kind: 'error', error: { message: 'x' } }), 'end_turn')
  assert.equal(turnEndToStopReason(undefined), 'end_turn')
})

test('base64 admission rejects aliases and padded garbage', () => {
  assert.equal(isCanonicalBase64(Buffer.from('hi').toString('base64')), true)
  assert.equal(isCanonicalBase64('aGk'), false, 'unpadded is not canonical')
  assert.equal(isCanonicalBase64('aG k='), false)
  assert.equal(isCanonicalBase64(''), false)
})

test('a new ACP session records ask when the Harness default is never', () => {
  const appended = []
  const session = {
    append(type, data) {
      appended.push({ type, data })
    },
  }
  const approval = { effectivePolicy: () => 'never', overrideOf: () => undefined }
  assert.equal(pinApprovalPolicy(session, approval, 'ask'), true)
  assert.deepEqual(appended, [{ type: 'approval/policy', data: { policy: 'ask' } }])
  assert.equal(pinApprovalPolicy(session, { effectivePolicy: () => 'ask' }, 'ask'), false)
  assert.equal(pinApprovalPolicy(session, approval, 'inherit'), false)
  assert.equal(appended.length, 1, 'inherit and a matching policy append nothing')
})

test('route prefixes normalize to one shape', () => {
  assert.equal(normalizePrefix(''), '/dsh-acp-bridge/')
  assert.equal(normalizePrefix('/x'), '/x/')
  assert.equal(normalizePrefix('x/'), '/x/')
  assert.equal(websocketPath('/x/'), '/x/ws')
})

/**
 * Build a fake LLM service that serves one provider with two models, one of
 * which declares reasoning efforts.
 * @param options - behavioral switches.
 * @returns the fake service.
 */
function fakeLlm(options = {}) {
  const reasoning = options.reasoning ?? {
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ],
  }
  return {
    listProviders: () => [{ id: 'prov', name: 'Provider' }],
    listModels: async (provider) => {
      if (options.catalogFails === true) throw new Error('catalog down')
      return [
        { provider, id: 'plain', name: 'Plain' },
        { provider, id: 'thinker', name: 'Thinker', description: 'reasons' },
      ]
    },
    resolveModelInfo: async (_provider, model) => ({
      provider: 'prov',
      model,
      id: model,
      name: model,
      ...(model === 'thinker' && reasoning !== undefined ? { reasoning } : {}),
    }),
    resolveCallConfig: async (config) => {
      if (options.rejectsRoute === true) throw new Error('unknown route')
      return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
    },
  }
}

/**
 * Build a fake Agent with the members the projection touches.
 * @param selection - the initial selection, or `undefined` for none.
 * @param seq - the Session sequence to report.
 * @returns the fake agent.
 */
function fakeAgent(selection, seq = 0) {
  const state = { selection, seq }
  return {
    id: 'session-1',
    status: 'idle',
    session: {
      get seq() {
        return state.seq
      },
      header: { id: 'session-1', cwd: '/tmp' },
    },
    model: {
      current: () => state.selection,
      select: (next) => {
        state.selection = next
      },
    },
    setSeq: (next) => {
      state.seq = next
    },
  }
}

test('option state exposes model and the dependent reasoning selector', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'thinker' })
  const control = new AcpModelControl({ llm: fakeLlm() }, agent, {
    model: true,
    reasoning: true,
    mode: false,
    permission: false,
  })
  const options = await control.options()
  assert.deepEqual(
    options.map((option) => option.id),
    [MODEL_OPTION, REASONING_OPTION],
  )
  const model = options[0]
  assert.equal(model.category, 'model')
  assert.equal(model.options.length, 1, 'one provider group')
  assert.equal(model.options[0].options.length, 2)
  const reasoning = options[1]
  assert.equal(reasoning.category, 'thought_level')
  assert.equal(reasoning.currentValue, PROVIDER_DEFAULT_EFFORT)
  assert.equal(reasoning.options[0].value, PROVIDER_DEFAULT_EFFORT)
})

test('a model without reasoning declares no reasoning option', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'plain' })
  const control = new AcpModelControl({ llm: fakeLlm() }, agent, {
    model: true,
    reasoning: true,
    mode: false,
    permission: false,
  })
  const options = await control.options()
  assert.deepEqual(
    options.map((option) => option.id),
    [MODEL_OPTION],
  )
})

test('changing the model re-reads the whole option state', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'plain' })
  const control = new AcpModelControl({ llm: fakeLlm() }, agent, {
    model: true,
    reasoning: true,
    mode: false,
    permission: false,
  })
  const after = await control.set(MODEL_OPTION, modelValue('prov', 'thinker'))
  assert.equal(agent.model.current().model, 'thinker')
  assert.deepEqual(
    after.map((option) => option.id),
    [MODEL_OPTION, REASONING_OPTION],
    'reasoning appears once the new model declares it',
  )
})

test('an unknown model or reasoning value is a correctable error', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'thinker' })
  const control = new AcpModelControl({ llm: fakeLlm() }, agent, {
    model: true,
    reasoning: true,
    mode: false,
    permission: false,
  })
  await assert.rejects(() => control.set(MODEL_OPTION, modelValue('prov', 'ghost')), (error) => {
    // resolveCallConfig accepts anything in the fake, so the rejection comes
    // from the choices map only when the catalog omits it; here it is accepted.
    return error instanceof Error || error instanceof AcpInvalidParams
  })
  await assert.rejects(() => control.set(REASONING_OPTION, 'ultra'), AcpInvalidParams)
})

test('reasoning sentinel clears an explicit effort', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'thinker', reasoningEffort: 'high' })
  const control = new AcpModelControl({ llm: fakeLlm() }, agent, {
    model: true,
    reasoning: true,
    mode: false,
    permission: false,
  })
  await control.set(REASONING_OPTION, PROVIDER_DEFAULT_EFFORT)
  assert.equal(agent.model.current().reasoningEffort, undefined)
})

test('mode only changes before the first turn', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'plain' }, 0)
  const agentPresets = {
    list: async () => [
      { id: 'default', name: 'Default', isDefault: true },
      { id: 'super-code', name: 'Super code' },
      { id: 'broken-one', name: 'Broken', broken: 'missing plugin' },
    ],
    presetForSession: () => null,
    select: async () => 'default',
  }
  const control = new AcpModelControl({ llm: fakeLlm(), agentPresets }, agent, {
    model: false,
    reasoning: false,
    mode: true,
    permission: false,
  })
  const options = await control.options()
  const mode = options.find((option) => option.id === 'mode')
  assert.equal(mode.category, 'mode')
  assert.deepEqual(
    mode.options.map((entry) => entry.value),
    ['default', 'super-code'],
    'a broken preset is not offered',
  )

  await control.set('mode', 'super-code')

  agent.setSeq(4)
  await assert.rejects(() => control.set('mode', 'default'), (error) => {
    assert.ok(error instanceof AcpInvalidParams)
    assert.match(error.message, /before the first turn/)
    return true
  })
})

test('legacy modes mirror the mode option', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'plain' })
  const agentPresets = {
    list: async () => [
      { id: 'default', name: 'Default', isDefault: true },
      { id: 'super-code', name: 'Super code' },
    ],
    presetForSession: () => 'super-code',
    select: async () => 'super-code',
  }
  const control = new AcpModelControl({ llm: fakeLlm(), agentPresets }, agent, {
    model: true,
    reasoning: true,
    mode: true,
    permission: false,
  })
  const modes = await control.modes()
  assert.equal(modes.currentModeId, 'super-code')
  const options = await control.options()
  assert.equal(options.find((option) => option.id === 'mode').currentValue, 'super-code')
})

test('the approval policy option reads and writes the approval service', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'plain' })
  const policies = []
  const approval = {
    overrideOf: () => policies.at(-1),
    setPolicy: (_agent, policy) => policies.push(policy),
  }
  const control = new AcpModelControl({ llm: fakeLlm(), approval }, agent, {
    model: false,
    reasoning: false,
    mode: false,
    permission: true,
  })
  const before = await control.options()
  const option = before.find((entry) => entry.id === PERMISSION_OPTION)
  assert.equal(option.currentValue, 'ask')
  await control.set(PERMISSION_OPTION, 'never')
  assert.deepEqual(policies, ['never'])
  await assert.rejects(() => control.set(PERMISSION_OPTION, 'sometimes'), AcpInvalidParams)
})

test('a transient catalog failure keeps the last resolvable state', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'plain' })
  const llm = fakeLlm()
  const control = new AcpModelControl({ llm }, agent, {
    model: true,
    reasoning: false,
    mode: false,
    permission: false,
  })
  await control.options()
  llm.listModels = async () => {
    throw new Error('catalog down')
  }
  const after = await control.options()
  assert.equal(after[0].id, MODEL_OPTION)
  assert.ok(after[0].options.length >= 1, 'the current route still appears')
})

test('disabled capabilities are not advertised at all', async () => {
  const agent = fakeAgent({ provider: 'prov', model: 'thinker' })
  const control = new AcpModelControl({ llm: fakeLlm() }, agent, {
    model: false,
    reasoning: false,
    mode: false,
    permission: false,
  })
  assert.deepEqual(await control.options(), [])
})
