/**
 * One ACP session's Agent, configuration view, prompt slot and teardown.
 *
 * The module mirrors the guarantees the shipped `@deepseek-ai/dsh-acp` adapter
 * establishes, and adds the two things that adapter deliberately omits: agent
 * presets as a session mode, and slash commands as `available_commands`.
 *
 * @module dsh-acp-bridge/session
 */

import { randomUUID } from 'node:crypto'

import { AcpInvalidParams, turnEndToStopReason } from './acp.js'
import { AcpModelControl } from './model-control.js'

/** Raster formats shared by ACP image blocks and the core attachment vocabulary. */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Compose the unpublished Agent scope. A profile-installed plugin cannot import
 * `@deepseek-ai/dsh-agent` (the profile does not carry the core packages), so the
 * optional model-switch notice is not installed; the session still records every
 * selection change through `agent.model.select()`.
 * @param _agentCtx - the unpublished Agent context.
 */
function composeAgent(_agentCtx) {
  // Intentionally empty: this bridge adds no scoped listeners of its own.
}

/**
 * Build one durable user message.
 *
 * `createUserMessage` lives in `@deepseek-ai/dsh-llm`, which a profile-installed
 * plugin cannot resolve. The value it produces is a plain identified record, so
 * the same shape is built here: a fresh id, the role, the content and a source.
 * @param content - admitted core content blocks.
 * @returns the message the Agent's inbox accepts.
 */
function userMessage(content) {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'user' },
  }
}

/**
 * Render one resource link into the core's text vocabulary. DSH has no durable
 * resource-link block, so the model reads it as an openable reference.
 * @param block - the ACP resource link.
 * @returns the text the model sees.
 */
function resourceLinkText(block) {
  return `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
}

/**
 * Admit one ACP prompt into ordered durable core content.
 *
 * Validation of the whole batch happens before any attachment write, and a
 * cancellation that wins admission never queues a late user message.
 *
 * @param services - attachment store and current route.
 * @param prompt - untrusted ACP prompt blocks, in wire order.
 * @param imageEnabled - whether this connection advertised image prompts.
 * @returns core content blocks in wire order.
 */
async function admitPrompt({ attachments, route }, prompt, imageEnabled) {
  const images = []
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
      case 'resource_link':
        break
      case 'image':
        if (!imageEnabled) throw new AcpInvalidParams('inline image prompts were not advertised by this connection')
        if (!IMAGE_MEDIA_TYPES.includes(block.mimeType)) {
          throw new AcpInvalidParams('image mimeType must be image/png, image/jpeg, image/webp, or image/gif')
        }
        images.push({ data: Buffer.from(block.data, 'base64'), mediaType: block.mimeType })
        break
      case 'audio':
        throw new AcpInvalidParams('audio prompt content is not supported')
      case 'resource':
        throw new AcpInvalidParams('embedded resource prompt content is not supported')
      default:
        throw new AcpInvalidParams('unsupported ACP prompt content')
    }
  }

  let refs = []
  if (images.length > 0) {
    if (attachments === undefined) throw new AcpInvalidParams('no attachment store is mounted')
    if (route === undefined) throw new AcpInvalidParams('the current model route could not be resolved')
    refs = await attachments.saveImages(images)
  }

  const content = []
  let pendingText = ''
  let imageIndex = 0
  const flush = () => {
    if (pendingText.length === 0) return
    content.push({ type: 'text', text: pendingText })
    pendingText = ''
  }
  for (const block of prompt) {
    if (block.type === 'text') {
      pendingText += block.text
    } else if (block.type === 'resource_link') {
      pendingText += resourceLinkText(block)
    } else if (block.type === 'image') {
      flush()
      content.push({ type: 'image', attachment: refs[imageIndex++] })
    }
  }
  flush()
  const usable =
    content.some((block) => block.type === 'image') ||
    content.some((block) => block.type === 'text' && block.text.trim().length > 0)
  if (!usable) throw new AcpInvalidParams('empty prompt')
  return content
}

/**
 * Convert one committed assistant block into ACP wire content.
 * @param services - attachment store used to re-read durable images.
 * @param block - the committed core block.
 * @returns ACP content, or `undefined` for blocks that stay off the wire.
 */
async function assistantBlockToAcp({ attachments }, block) {
  if (block.type === 'text') {
    return block.text.length === 0 ? undefined : { type: 'text', text: block.text }
  }
  if (block.type !== 'image') return undefined
  if (attachments === undefined) return undefined
  const stored = await attachments.readImage(block.attachment)
  return {
    type: 'image',
    data: Buffer.from(stored.data).toString('base64'),
    mimeType: stored.ref.mediaType,
  }
}

/** One ACP session: one Agent, one in-flight prompt, one ordered update chain. */
export class AcpSession {
  /**
   * @param deps - Host services, the per-connection notifier, and options.
   */
  constructor({ ctx, agent, handle, notify, expose, approvalTimeoutMs, onEvent }) {
    this.ctx = ctx
    this.agent = agent
    this.handle = handle
    this.notify = notify
    this.expose = expose
    this.approvalTimeoutMs = approvalTimeoutMs
    this.onEvent = onEvent
    this.modelControl = new AcpModelControl(
      {
        llm: ctx.llm,
        agentPresets: ctx.get('agentPresets'),
        approval: ctx.get('approval'),
      },
      agent,
      expose,
    )
    this.outputTail = Promise.resolve()
    this.inflight = undefined
    this.closing = undefined
    this.pendingApproval = undefined
  }

  /**
   * Create a fresh Agent for this ACP session.
   * @param deps - Host services and the connection notifier.
   * @param options - identity, workspace and route options.
   * @returns the session module.
   */
  static async create(deps, options) {
    const handle = await deps.ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd: options.cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: (agentCtx) => composeAgent(agentCtx),
    })
    return new AcpSession({ ...deps, agent: handle.agent, handle })
  }

  /**
   * Resume a persisted Agent for this ACP session.
   * @param deps - Host services and the connection notifier.
   * @param options - persisted identity and route options.
   * @returns the session module.
   */
  static async resume(deps, options) {
    const handle = await deps.ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: (agentCtx) => composeAgent(agentCtx),
    })
    return new AcpSession({ ...deps, agent: handle.agent, handle })
  }

  /** The ACP session id. */
  get id() {
    return this.agent.session.id
  }

  /** Reject work on a session that is already tearing down. */
  assertActive() {
    if (this.closing !== undefined) throw new AcpInvalidParams(`session is closing: ${this.id}`)
  }

  /**
   * Read the complete configuration state.
   * @param signal - optional cancellation.
   * @returns every advertised option.
   */
  configOptions(signal) {
    this.assertActive()
    return this.modelControl.serialize(() => this.modelControl.options(signal))
  }

  /**
   * Read ACP's legacy modes field.
   * @returns the mode state, when presets are exposed.
   */
  modes() {
    return this.modelControl.modes()
  }

  /**
   * Apply one option change.
   * @param configId - option id.
   * @param value - selected wire value.
   * @param signal - optional cancellation.
   * @returns the complete resulting state.
   */
  setConfig(configId, value, signal) {
    this.assertActive()
    return this.modelControl.set(configId, value, signal)
  }

  /**
   * Apply ACP's legacy `session/set_mode`.
   * @param modeId - preset identity.
   * @param signal - optional cancellation.
   * @returns the complete resulting option state.
   */
  setMode(modeId, signal) {
    this.assertActive()
    return this.modelControl.set('mode', modeId, signal)
  }

  /**
   * Publish the live slash commands as an ACP `available_commands_update`.
   * @returns the update, or `undefined` when nothing should be sent.
   */
  async commandsUpdate() {
    if (!this.expose.commands) return undefined
    const commands = this.ctx.get('commands')
    if (commands === undefined) return undefined
    const listed = commands.list(this.agent)
    if (listed.length === 0) return undefined
    return {
      sessionUpdate: 'available_commands_update',
      availableCommands: listed.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input === undefined
          ? {}
          : { input: { _dsh_hint: command.input.hint, attachments: command.input.attachments === true } }),
      })),
    }
  }

  /**
   * Execute one slash command and report its result as a message chunk.
   * @param line - the complete command line including the leading slash.
   * @returns whether the line was handled as a command.
   */
  async maybeRunCommand(line) {
    if (!this.expose.commands) return false
    const commands = this.ctx.get('commands')
    if (commands === undefined) return false
    if (!line.startsWith('/')) return false
    try {
      const execution = await commands.execute(this.agent, line, [], new AbortController().signal)
      if (execution === undefined) return false
      const text = execution.result.text ?? ''
      if (text.length > 0) {
        await this.enqueue({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        })
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * Admit one prompt and settle after the root, its descendants and the update
   * chain have all finished.
   * @param params - the ACP prompt request.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param requestSignal - JSON-RPC request cancellation.
   * @returns the correlated stop reason.
   */
  async prompt(params, imageEnabled, requestSignal) {
    this.assertActive()
    if (this.inflight !== undefined) throw new AcpInvalidParams('a prompt is already in flight for this session')

    const text = params.prompt
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')

    // A slash command is handled by the Harness registry, not by the model.
    if (await this.maybeRunCommand(text.trim())) {
      return { stopReason: 'end_turn' }
    }

    const completion = Promise.withResolvers()
    const admission = Promise.withResolvers()
    const admissionController = new AbortController()
    const inflight = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      messageQueued: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    }
    this.inflight = inflight

    const onAbort = () => this.cancelPrompt('ACP prompt request cancelled')
    requestSignal?.addEventListener('abort', onAbort, { once: true })
    if (requestSignal?.aborted === true) onAbort()

    try {
      let admissionFailure
      const routeSelection = this.agent.model.current()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw new AcpInvalidParams('prompt was not queued: the agent was disposed outside the bridge')
        }
        const content = await admitPrompt(
          { attachments: this.ctx.get('attachments'), route: routeSelection },
          params.prompt,
          imageEnabled,
        )
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw new AcpInvalidParams('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = userMessage(content)
        inflight.messageId = message.id
        inflight.messageQueued = true
        try {
          this.agent.followup(message)
        } catch (error) {
          inflight.messageQueued = false
          throw error
        }
      } catch (error) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }

      if (inflight.admissionController.signal.aborted) {
        this.settle(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined
        throw admissionFailure
      }
      this.settle(inflight)
      return { stopReason: await completion.promise }
    } finally {
      requestSignal?.removeEventListener('abort', onAbort)
    }
  }

  /** Cancel the active prompt, or autonomous work when none is in flight. */
  cancel() {
    const inflight = this.inflight
    this.cancelPrompt('ACP prompt cancelled')
    if (inflight === undefined) this.agent.cancel({ kind: 'user' })
  }

  /**
   * Project one committed session event onto the ACP wire.
   * @param session - the event's owning Session.
   * @param event - the committed event.
   */
  onSessionEvent(session, event) {
    if (session !== this.agent.session) return
    if (event.type === 'turn/start' && this.inflight !== undefined) {
      this.inflight.turn = event.data.turn
      this.inflight.endReason = undefined
    }
    if (event.type === 'assistant/message') {
      const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
      const delivery = this.outputTail.then(async () => {
        for (const update of await this.#assistantUpdates(session, event)) await this.notify(this.id, update)
      })
      this.outputTail = delivery.catch((error) => {
        if (inflight !== undefined) inflight.outputError ??= error
        this.ctx.logger?.warn?.(`acp-bridge: assistant output conversion failed: ${error?.message ?? error}`)
      })
      return
    }
    if (event.type === 'tool/call') {
      // `todo_write` is the Harness's plan primitive: its arguments carry the
      // complete task list, which is exactly what ACP's plan update wants. Send
      // the plan before the tool card so a client renders the plan first.
      if (this.expose.plan && event.data.name === 'todo_write') {
        const entries = planEntries(event.data.arguments)
        if (entries !== undefined) this.enqueue({ sessionUpdate: 'plan', entries })
      }
      const previous = this.outputTail
      this.outputTail = previous
        .then(() =>
          this.notify(this.id, {
            sessionUpdate: 'tool_call',
            toolCallId: event.data.callId,
            title: event.data.name,
            name: event.data.name,
            kind: 'other',
            status: 'in_progress',
            rawInput: parseArguments(event.data.arguments),
          }),
        )
        .catch(() => undefined)
      return
    }
    if (event.type === 'tool/result') {
      const previous = this.outputTail
      this.outputTail = previous
        .then(async () => this.notify(this.id, await this.#toolResultUpdate(event)))
        .catch(() => undefined)
      return
    }
    if (event.type === 'turn/end' && this.inflight !== undefined && this.inflight.turn === event.data.turn) {
      this.inflight.endReason = event.data.reason
      this.inflight.agentError = undefined
    }
  }

  /**
   * Correlate an accepted user message with its Agent turn.
   * @param message - the claimed durable inbox message.
   * @param turn - the allocated turn.
   */
  onInboxClaimed(message, turn) {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) {
      this.inflight.turn = turn
    }
  }

  /**
   * Correlate an Agent failure with the active prompt.
   * @param error - the same-process failure.
   */
  onAgentError(error) {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    inflight.agentError = error instanceof Error ? error : new Error(String(error))
    this.settle(inflight)
  }

  /** Wait for every update queued before this call. */
  drainUpdates() {
    return this.outputTail
  }

  /**
   * Cancel, drain, flush and dispose this session exactly once.
   * @param detail - cancellation detail for a prompt still in admission.
   * @returns the shared quiescent teardown promise.
   */
  close(detail) {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const failures = []
      const inflight = this.inflight
      this.cancelPrompt(detail)
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      this.#settlePendingApproval()
      try {
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
      } catch (error) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
      try {
        await this.ctx.get('subagents')?.drainDescendants?.([this.agent])
      } catch (error) {
        failures.push(new Error('subagent teardown failed', { cause: error }))
      }
      try {
        await this.ctx.sessions?.flush?.(this.agent.session)
      } catch (error) {
        failures.push(new Error('session persistence flush failed', { cause: error }))
      }
      try {
        await this.handle.dispose()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, `ACP session teardown failed for ${this.id}`)
      }
    })()
    return this.closing
  }

  /**
   * Register a pending permission request so the panel can answer it.
   * Only one request per session can be pending: the Agent serializes them.
   * @param request - the approval details.
   * @param answer - resolves the request; called exactly once.
   */
  holdApproval(request, answer) {
    this.#settlePendingApproval()
    const timer = setTimeout(() => {
      answer('rejected')
      this.#clearApproval()
    }, this.approvalTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    this.pendingApproval = { request, answer, timer }
    this.onEvent?.({
      kind: 'approval',
      id: this.id,
      callId: request.callId,
      toolName: request.toolName,
      reason: request.reason,
      expiresAt: Date.now() + this.approvalTimeoutMs,
    })
  }

  /**
   * Answer the pending permission request from the Harness panel.
   * @param allow - whether to grant it once.
   * @returns whether a request was pending.
   */
  answerPendingApproval(allow) {
    const pending = this.pendingApproval
    if (pending === undefined) return false
    this.#clearApproval()
    pending.answer(allow ? 'allowed-once' : 'rejected')
    return true
  }

  /** The pending approval, for the panel's view. */
  pendingApprovalView() {
    const pending = this.pendingApproval
    if (pending === undefined) return undefined
    return {
      callId: pending.request.callId,
      toolName: pending.request.toolName,
      reason: pending.request.reason,
    }
  }

  /** Resolve one approval request when its client went away. */
  #clearApproval() {
    const pending = this.pendingApproval
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingApproval = undefined
    this.onEvent?.({ kind: 'approval-cleared', id: this.id })
  }

  /** Fail a pending approval closed on teardown. */
  #settlePendingApproval() {
    const pending = this.pendingApproval
    if (pending === undefined) return
    this.#clearApproval()
    pending.answer('cancelled')
  }

  /** Cancel admission and Agent activity for one in-flight prompt. */
  cancelPrompt(detail) {
    const inflight = this.inflight
    if (inflight === undefined) return
    inflight.admissionController.abort(new Error(detail))
    this.settle(inflight)
    if (!inflight.messageQueued) return
    this.agent.cancel({ kind: 'user' })
  }

  /**
   * Resolve one prompt once its admission, its turns, its descendants and its
   * queued updates have all settled.
   * @param inflight - the prompt record to settle.
   */
  settle(inflight) {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    ;(async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        const subagents = this.ctx.get('subagents')
        const cancelled = () => inflight.admissionController.signal.aborted
        const idleAt = (seq) => this.agent.status === 'idle' && this.agent.session.seq === seq
        while (true) {
          await this.agent.whenIdle()
          if (cancelled()) break
          const idleSeq = this.agent.session.seq
          const children = await subagents?.waitForTreeWork?.(this.agent)
          if (cancelled()) break
          if (children === true || !idleAt(idleSeq)) continue
          await this.outputTail
          if (cancelled() || idleAt(idleSeq)) break
        }
      }
      if (this.inflight !== inflight) return
      this.inflight = undefined
      if (inflight.admissionController.signal.aborted) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(new Error(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(new Error(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        inflight.reject(new Error(`turn failed: ${end.error?.message ?? 'unknown error'}`))
      } else {
        inflight.resolve(turnEndToStopReason(end))
      }
    })().catch((error) => {
      if (this.inflight !== inflight) return
      this.inflight = undefined
      inflight.reject(error)
    })
  }

  /** Append one update to the per-session serialized output chain. */
  enqueue(update) {
    const previous = this.outputTail
    this.outputTail = previous.then(() => this.notify(this.id, update)).catch(() => undefined)
    return this.outputTail
  }

  /** Convert one committed assistant message into ordered ACP updates. */
  async #assistantUpdates(session, event) {
    const updates = []
    const services = { attachments: this.ctx.get('attachments') }
    for (const block of event.data.message.content) {
      if (block.type === 'reasoning') {
        if (block.text.length > 0) {
          updates.push({
            sessionUpdate: 'agent_thought_chunk',
            messageId: event.data.message.id,
            content: { type: 'text', text: block.text },
          })
        }
        continue
      }
      const content = await assistantBlockToAcp(services, block)
      if (content !== undefined) {
        updates.push({
          sessionUpdate: 'agent_message_chunk',
          messageId: event.data.message.id,
          content,
        })
      }
    }
    if (this.expose.usage) {
      const usage = this.#usageUpdate(session, event)
      if (usage !== undefined) updates.push(usage)
    }
    return updates
  }

  /** Report context occupancy only when both the usage and the capacity exist. */
  #usageUpdate(session, event) {
    if (event.data.usage === undefined) return undefined
    const size = session.requestContext()?.contextWindow
    const meter = this.ctx.get('tokenMeter')
    if (size === undefined || meter === undefined) return undefined
    return {
      sessionUpdate: 'usage_update',
      used: meter.measure(session).totalTokens,
      size,
    }
  }

  /** Convert one committed tool result into an ACP tool-call update. */
  async #toolResultUpdate(event) {
    const message = event.data.message
    const services = { attachments: this.ctx.get('attachments') }
    const content = []
    for (const block of message.content) {
      const converted = await assistantBlockToAcp(services, block)
      if (converted !== undefined) content.push({ type: 'content', content: converted })
    }
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: message.toolCallId,
      status: message.isError === true ? 'failed' : 'completed',
      content,
    }
  }
}

/**
 * Preserve malformed model output instead of dropping the whole call update.
 * @param value - the recorded argument string.
 * @returns parsed JSON when possible, else the raw string.
 */
function parseArguments(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** Map the Harness's todo statuses onto the ACP plan vocabulary. */
const PLAN_STATUS = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
}

/**
 * Convert a `todo_write` argument payload into ACP plan entries.
 *
 * The tool takes the COMPLETE list, which matches ACP's replace-the-whole-plan
 * semantics exactly, so no diffing is needed here.
 *
 * @param raw - the recorded argument JSON string.
 * @returns the entries, or `undefined` when the payload is unusable.
 */
function planEntries(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const todos = parsed?.todos
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  const entries = []
  for (const todo of todos) {
    const content = typeof todo?.content === 'string' ? todo.content.trim() : ''
    if (content.length === 0) continue
    entries.push({
      content,
      priority: 'medium',
      status: PLAN_STATUS[todo?.status] ?? 'pending',
    })
  }
  return entries.length === 0 ? undefined : entries
}
