/**
 * Event-projection tests: the pure translations from committed Harness events
 * onto the ACP wire. These need no Host, so they pin the observable output of
 * `onSessionEvent` and the plan/command conversions.
 *
 * Run with `node --test test/`.
 *
 * @module dsh-acp-bridge/test/projection
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AcpSession } from '../lib/session.js'

/**
 * Build a session module whose Host services are inert fakes.
 * @param options - exposed capabilities and queued commands.
 * @returns the session plus the recorded updates.
 */
function makeSession(options = {}) {
  const sent = []
  const liveAgents = new Set()
  const ctx = {
    logger: { warn: () => undefined },
    get: (key) => {
      if (key === 'commands') return options.commands
      if (key === 'tokenMeter') return options.meter
      return undefined
    },
    // The prompt path re-checks that the Agent is still the registered one, so
    // the double has to answer as the live registry does.
    agents: { get: (id) => [...liveAgents].find((entry) => entry.id === id) },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ provider: 'p', model: 'm', id: 'm', name: 'm' }),
      resolveCallConfig: async (config) => config,
    },
    sessions: { flush: async () => undefined },
  }
  const agent = {
    id: 's1',
    status: 'idle',
    session: {
      id: 's1',
      header: { id: 's1', cwd: '/tmp' },
      seq: 0,
      requestContext: () => ({ contextWindow: 1000 }),
    },
    model: { current: () => ({ provider: 'p', model: 'm' }), select: () => undefined },
    whenIdle: async () => undefined,
    cancel: () => undefined,
    followup: (message) => {
      inbox.push(message)
    },
  }
  const inbox = []
  liveAgents.add(agent)
  const session = new AcpSession({
    ctx,
    agent,
    handle: { dispose: async () => undefined },
    notify: async (sessionId, update) => {
      assert.equal(sessionId, 's1')
      sent.push(update)
    },
    expose: {
      model: true,
      reasoning: true,
      mode: true,
      permission: true,
      commands: options.commands !== undefined,
      plan: options.plan !== false,
      usage: options.usage !== false,
      images: false,
    },
    approvalTimeoutMs: 50,
    onEvent: () => undefined,
  })
  return { session, agent, sent, inbox }
}

/** Drain the session's output chain so callers can assert on `sent`. */
async function drain(session) {
  await session.drainUpdates()
  // One extra microtask turn lets any chained `.then` settle.
  await new Promise((resolve) => setImmediate(resolve))
}

test('a todo_write call publishes a plan before its tool card', async () => {
  const { session, sent } = makeSession()
  session.onSessionEvent(session.agent.session, {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'todo_write',
      arguments: JSON.stringify({
        todos: [
          { content: 'Read the schema', status: 'completed' },
          { content: 'Write the bridge', status: 'in_progress' },
          { content: 'Ship it', status: 'pending' },
        ],
      }),
    },
  })
  await drain(session)
  assert.deepEqual(
    sent.map((update) => update.sessionUpdate),
    ['plan', 'tool_call'],
  )
  assert.deepEqual(sent[0].entries, [
    { content: 'Read the schema', priority: 'medium', status: 'completed' },
    { content: 'Write the bridge', priority: 'medium', status: 'in_progress' },
    { content: 'Ship it', priority: 'medium', status: 'pending' },
  ])
})

test('a non-plan tool call publishes only the tool card', async () => {
  const { session, sent } = makeSession()
  session.onSessionEvent(session.agent.session, {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{"path":"a"}' },
  })
  await drain(session)
  assert.deepEqual(
    sent.map((update) => update.sessionUpdate),
    ['tool_call'],
  )
  assert.deepEqual(sent[0].rawInput, { path: 'a' })
})

test('malformed tool arguments survive as opaque input', async () => {
  const { session, sent } = makeSession()
  session.onSessionEvent(session.agent.session, {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: 'not json' },
  })
  await drain(session)
  assert.equal(sent[0].rawInput, 'not json')
})

test('plan reporting can be turned off without losing the tool card', async () => {
  const { session, sent } = makeSession({ plan: false })
  session.onSessionEvent(session.agent.session, {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      callId: 'c',
      name: 'todo_write',
      arguments: JSON.stringify({ todos: [{ content: 'x', status: 'pending' }] }),
    },
  })
  await drain(session)
  assert.deepEqual(
    sent.map((update) => update.sessionUpdate),
    ['tool_call'],
  )
})

test('assistant text and reasoning become ordered chunks', async () => {
  const { session, sent } = makeSession()
  session.onSessionEvent(session.agent.session, {
    type: 'assistant/message',
    seq: 2,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'm1',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'answer' },
          { type: 'tool-call', id: 't', name: 'read', arguments: '{}' },
        ],
      },
      stream: [],
    },
  })
  await drain(session)
  assert.deepEqual(
    sent.map((update) => update.sessionUpdate),
    ['agent_thought_chunk', 'agent_message_chunk'],
    'a tool-call block stays off the message channel',
  )
  assert.equal(sent[0].messageId, 'm1')
  assert.equal(sent[1].content.text, 'answer')
})

test('usage is omitted when the meter or the context window is missing', async () => {
  const withoutMeter = makeSession()
  withoutMeter.session.onSessionEvent(withoutMeter.agent.session, {
    type: 'assistant/message',
    seq: 2,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      stream: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  })
  await drain(withoutMeter.session)
  assert.ok(!withoutMeter.sent.some((update) => update.sessionUpdate === 'usage_update'))

  const withMeter = makeSession({ meter: { measure: () => ({ totalTokens: 42 }) } })
  withMeter.session.onSessionEvent(withMeter.agent.session, {
    type: 'assistant/message',
    seq: 2,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      stream: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  })
  await drain(withMeter.session)
  const usage = withMeter.sent.find((update) => update.sessionUpdate === 'usage_update')
  assert.deepEqual(usage, { sessionUpdate: 'usage_update', used: 42, size: 1000 })
})

test('slash commands are published as available_commands', async () => {
  const commands = {
    list: () => [
      { name: 'context', description: 'Show context usage' },
      { name: 'compact', description: 'Compact now', input: { hint: 'reason' } },
    ],
    execute: async () => undefined,
  }
  const { session } = makeSession({ commands })
  const update = await session.commandsUpdate()
  assert.equal(update.sessionUpdate, 'available_commands_update')
  assert.deepEqual(
    update.availableCommands.map((command) => command.name),
    ['context', 'compact'],
  )
  assert.deepEqual(update.availableCommands[1].input, { _dsh_hint: 'reason', attachments: false })
})

test('a slash command runs through the registry instead of the model', async () => {
  const executed = []
  const commands = {
    list: () => [{ name: 'context', description: 'Show context' }],
    execute: async (_agent, line) => {
      executed.push(line)
      return { commandId: 'c1', result: { kind: 'success', text: '42k of 200k' } }
    },
  }
  const { session, sent } = makeSession({ commands })
  const handled = await session.prompt({ prompt: [{ type: 'text', text: '/context' }] }, false, undefined)
  assert.equal(handled.stopReason, 'end_turn')
  assert.deepEqual(executed, ['/context'])
  assert.equal(sent[0].content.text, '42k of 200k')
})

test('a line the registry does not know is not treated as a command', async () => {
  const commands = {
    list: () => [],
    execute: async () => undefined,
  }
  const { session } = makeSession({ commands })
  assert.equal(await session.maybeRunCommand('/nope'), false)
  assert.equal(await session.maybeRunCommand('plain text'), false)
})

test('an empty prompt is rejected as a correctable error', async () => {
  const { session } = makeSession()
  await assert.rejects(
    () => session.prompt({ prompt: [{ type: 'text', text: '   ' }] }, false, undefined),
    (error) => {
      assert.match(error.message, /empty prompt/)
      return true
    },
  )
})

test('image prompts are refused when the connection did not advertise them', async () => {
  const { session } = makeSession()
  await assert.rejects(
    () =>
      session.prompt(
        { prompt: [{ type: 'image', data: Buffer.from('x').toString('base64'), mimeType: 'image/png' }] },
        false,
        undefined,
      ),
    (error) => {
      assert.match(error.message, /not advertised/)
      return true
    },
  )
})

test('a second prompt while one is in flight is refused', async () => {
  const { session, agent } = makeSession()
  let release
  agent.whenIdle = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const first = session.prompt({ prompt: [{ type: 'text', text: 'hello' }] }, false, undefined)
  // The admission path reaches followup synchronously through a microtask.
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    () => session.prompt({ prompt: [{ type: 'text', text: 'again' }] }, false, undefined),
    (error) => {
      assert.match(error.message, /already in flight/)
      return true
    },
  )
  session.cancel()
  release?.()
  await first.catch(() => undefined)
})
