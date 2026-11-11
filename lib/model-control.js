/**
 * Selection projection: turns DSH's live model/preset/approval state into the
 * ACP `configOptions` array, and applies client changes back into the Harness.
 *
 * The projection is the only place that knows which capability answers which
 * option id, so `session/new`, `session/set_config_option` and the
 * `config_option_update` notification all agree by construction.
 *
 * @module dsh-acp-bridge/model-control
 */

import {
  AcpInvalidParams,
  MODE_OPTION,
  MODEL_OPTION,
  PERMISSION_OPTION,
  PROVIDER_DEFAULT_EFFORT,
  REASONING_OPTION,
  modelValue,
  parseModelValue,
} from './acp.js'

/** Approval policy values this bridge exposes as a select. */
const PERMISSION_VALUES = new Set(['ask', 'never'])

/**
 * Owns the config-option view of one ACP session.
 *
 * Agent model selection lives in the Session log (that is the only durable
 * state); the preset lives in the Agent's composition; the approval policy
 * lives in the approval service. This class reads all three and writes each
 * back through its owning API — never by mutating a cached copy.
 */
export class AcpModelControl {
  /**
   * @param services - the Host services this projection needs.
   * @param services.llm - the live LLM service (`ctx.llm`).
   * @param services.agentPresets - preset roster, when mounted.
   * @param services.approval - approval service, when mounted.
   * @param agent - the Agent this session drives.
   * @param expose - which options may be advertised at all.
   */
  constructor({ llm, agentPresets, approval, logger }, agent, expose) {
    this.llm = llm
    this.agentPresets = agentPresets
    this.approval = approval
    this.logger = logger
    this.agent = agent
    this.expose = expose
    this.tail = Promise.resolve()
    this.hasResolvedState = false
  }

  /**
   * Serialize mutations in receive order without wedging after a rejection.
   * @param operation - the mutation to run alone.
   * @returns the mutation's result.
   */
  serialize(operation) {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Read the complete option state.
   *
   * A session with no model selection still reports the options that do not
   * depend on one (mode, approval policy). Returning nothing at all would hide
   * a working mode selector from the client merely because the deployment has
   * no default model, and the user would have no way to act.
   *
   * @param signal - optional cancellation for catalog lookups.
   * @returns every advertised option and its current value.
   */
  async options(signal) {
    const selection = this.agent.model.current()
    const options = []

    if (selection === undefined) {
      this.logger?.warn?.(
        'acp-bridge: this session has no model selection; the model and reasoning selectors cannot be advertised',
      )
      if (this.expose.mode) {
        const mode = await this.#modeOption()
        if (mode !== undefined) options.push(mode)
      }
      if (this.expose.permission && this.approval !== undefined) {
        options.push(this.#permissionOption())
      }
      return options
    }

    let resolved = selection
    let routeAvailable = true
    if (this.expose.model) {
      try {
        resolved = await this.#resolve(selection, signal)
        this.hasResolvedState = true
      } catch (error) {
        if (!this.hasResolvedState) throw error
        resolved = selection
        routeAvailable = false
      }
    }

    if (this.expose.model) {
      options.push(await this.#modelOption(resolved, signal))
    }
    if (this.expose.reasoning) {
      const reasoning = await this.#reasoningOption(resolved, routeAvailable, signal)
      if (reasoning !== undefined) options.push(reasoning)
    }
    if (this.expose.mode) {
      const mode = await this.#modeOption()
      if (mode !== undefined) options.push(mode)
    }
    if (this.expose.permission && this.approval !== undefined) {
      options.push(this.#permissionOption())
    }
    return options
  }

  /**
   * Set one advertised option and return the complete resulting state.
   * @param configId - the option id from a previous read.
   * @param value - the selected wire value.
   * @param signal - optional cancellation.
   * @returns every option after the change.
   */
  set(configId, value, signal) {
    return this.serialize(async () => {
      // `''` is the legitimate "provider decides" sentinel for the reasoning
      // option, so emptiness is only invalid for the other selectors.
      if (typeof value !== 'string') {
        throw new AcpInvalidParams(`${configId} requires a select value`)
      }
      if (value.length === 0 && configId !== REASONING_OPTION) {
        throw new AcpInvalidParams(`${configId} requires a select value`)
      }
      if (configId === MODEL_OPTION) {
        const route = parseModelValue(value)
        if (route === undefined) throw new AcpInvalidParams(`unknown model option: ${value}`)
        // Membership in the advertised catalog is what makes a value legal.
        // Without this check any `[provider, model]` pair would be accepted,
        // including routes the client was never shown.
        const advertised = await this.#advertisedRoutes(signal)
        const key = modelValue(route.provider, route.model)
        if (!advertised.has(key)) throw new AcpInvalidParams(`unknown model option: ${value}`)
        const next = await this.#resolve(route, signal)
        this.agent.model.select(next)
      } else if (configId === REASONING_OPTION) {
        const current = this.agent.model.current()
        if (current === undefined) throw new AcpInvalidParams('this session has no model selection')
        const info = await this.llm.resolveModelInfo(current.provider, current.model, signal)
        if (info.reasoning === undefined) {
          throw new AcpInvalidParams(`model ${current.model} declares no reasoning effort`)
        }
        const useDefault = value === PROVIDER_DEFAULT_EFFORT
        if (!useDefault && !info.reasoning.efforts.some((effort) => String(effort.id) === value)) {
          throw new AcpInvalidParams(`unknown reasoning effort for ${current.model}: ${value}`)
        }
        this.agent.model.select(
          await this.#resolve(
            {
              provider: current.provider,
              model: current.model,
              ...(useDefault ? {} : { reasoningEffort: value }),
            },
            signal,
          ),
        )
      } else if (configId === MODE_OPTION) {
        await this.#setMode(value)
      } else if (configId === PERMISSION_OPTION) {
        if (!PERMISSION_VALUES.has(value)) throw new AcpInvalidParams(`unknown permission policy: ${value}`)
        this.approval.setPolicy(this.agent, value)
      } else {
        throw new AcpInvalidParams(`unknown session config option: ${configId}`)
      }
      return this.options(signal)
    })
  }

  /**
   * Apply an agent preset the way the Harness allows: only before the first
   * turn, and only through the preset registry.
   * @param id - preset identity.
   */
  async #setMode(id) {
    if (this.agentPresets === undefined) throw new AcpInvalidParams('this Harness mounts no agent presets')
    const roster = await this.agentPresets.list()
    if (!roster.some((preset) => preset.id === id)) throw new AcpInvalidParams(`unknown mode: ${id}`)
    const session = this.agent.session
    if (session.seq > 0) {
      throw new AcpInvalidParams(
        'the mode can only change before the first turn: an agent preset fixes the tool set, prompt and permission policy',
      )
    }
    await this.agentPresets.select(this.agent, id)
  }

  /**
   * Validate an exact route and keep only Agent-owned selection fields.
   * @param selection - provider/model/effort triple, possibly partial.
   * @param signal - optional cancellation.
   * @returns the materialized selection.
   */
  async #resolve(selection, signal) {
    const resolved = await this.llm.resolveCallConfig(selection, signal)
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
  }

  /**
   * Read the catalog keys the model selector currently advertises.
   * @param signal - optional cancellation.
   * @returns the set of legal selector values, plus the current route.
   */
  async #advertisedRoutes(signal) {
    const keys = new Set()
    const current = this.agent.model.current()
    if (current !== undefined) keys.add(modelValue(current.provider, current.model))
    await Promise.all(
      this.llm.listProviders().map(async (provider) => {
        try {
          for (const model of await this.llm.listModels(provider.id)) {
            keys.add(modelValue(provider.id, model.id))
          }
        } catch {
          // An unreachable catalog cannot authorize a value it did not list.
        }
      }),
    )
    return keys
  }

  /** Build the provider-grouped model selector. */
  async #modelOption(resolved, signal) {
    const groups = await Promise.all(
      this.llm.listProviders().map(async (provider) => {
        try {
          const models = await this.llm.listModels(provider.id)
          return {
            group: provider.id,
            name: provider.name ?? provider.id,
            options: models.map((model) => ({
              value: modelValue(provider.id, model.id),
              name: model.name ?? model.id,
              ...(model.description === undefined ? {} : { description: model.description }),
            })),
          }
        } catch {
          return { group: provider.id, name: provider.name ?? provider.id, options: [] }
        }
      }),
    )
    const currentValue = modelValue(resolved.provider, resolved.model)
    const known = groups.some((group) => group.options.some((option) => option.value === currentValue))
    if (!known) {
      let group = groups.find((entry) => entry.group === resolved.provider)
      if (group === undefined) {
        group = { group: resolved.provider, name: resolved.provider, options: [] }
        groups.push(group)
      }
      group.options.unshift({ value: currentValue, name: resolved.model })
    }
    return {
      id: MODEL_OPTION,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: groups.filter((group) => group.options.length > 0),
    }
  }

  /** Build the dependent reasoning selector, or nothing when unsupported. */
  async #reasoningOption(resolved, routeAvailable, signal) {
    if (!routeAvailable) return undefined
    const info = await this.llm.resolveModelInfo(resolved.provider, resolved.model, signal)
    if (info.reasoning === undefined) return undefined
    const efforts = info.reasoning.efforts.map((effort) => ({
      value: String(effort.id),
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
    }))
    const options =
      info.reasoning.defaultEffort === undefined
        ? [{ value: PROVIDER_DEFAULT_EFFORT, name: 'Provider default' }, ...efforts]
        : efforts
    return {
      id: REASONING_OPTION,
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue:
        resolved.reasoningEffort === undefined
          ? PROVIDER_DEFAULT_EFFORT
          : String(resolved.reasoningEffort),
      options,
    }
  }

  /** Build the agent-preset selector, mirroring ACP's legacy modes field. */
  async #modeOption() {
    if (this.agentPresets === undefined) return undefined
    const roster = await this.agentPresets.list()
    const usable = roster.filter((preset) => preset.broken === undefined)
    if (usable.length === 0) return undefined
    const current = this.agentPresets.presetForSession(this.agent.session) ?? this.#defaultPreset(roster)
    return {
      id: MODE_OPTION,
      name: 'Agent mode',
      description:
        'Agent presets fix the tool set, system prompt and permission policy. A preset can only change before the first turn.',
      category: 'mode',
      type: 'select',
      currentValue: current ?? usable[0].id,
      options: usable.map((preset) => ({
        value: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.description === undefined ? {} : { description: preset.description }),
      })),
    }
  }

  /** Read the roster's declared default, falling back to the first entry. */
  #defaultPreset(roster) {
    return roster.find((preset) => preset.isDefault === true)?.id
  }

  /** Build the approval-policy selector. */
  #permissionOption() {
    const override = this.approval.overrideOf(this.agent.session)
    return {
      id: PERMISSION_OPTION,
      name: 'Harness approvals',
      description:
        'This is not the IDE permission mode. Ask the client lets JetBrains apply its own modes (read-only, workspace edits, review, full access). Reject without asking never reaches the IDE: Harness refuses the tool.',
      category: '_dsh_permission',
      type: 'select',
      currentValue: override ?? 'ask',
      options: [
        {
          value: 'ask',
          name: 'Ask the client',
          description:
            'Tools that need approval are sent to JetBrains. Its permission mode then decides whether to ask, limit, or allow.',
        },
        {
          value: 'never',
          name: 'Reject without asking',
          description:
            'Harness refuses approval-requiring tools itself. This is not full access, and the IDE permission mode is not consulted.',
        },
      ],
    }
  }

  /**
   * Build ACP's legacy `modes` field so clients that ignore `configOptions`
   * still see the preset roster. The protocol requires both to agree.
   * @returns the mode state, or `undefined` when presets are not exposed.
   */
  async modes() {
    if (!this.expose.mode || this.agentPresets === undefined) return undefined
    const roster = await this.agentPresets.list()
    const usable = roster.filter((preset) => preset.broken === undefined)
    if (usable.length === 0) return undefined
    const current =
      this.agentPresets.presetForSession(this.agent.session) ?? this.#defaultPreset(roster) ?? usable[0].id
    return {
      currentModeId: current,
      availableModes: usable.map((preset) => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.description === undefined ? {} : { description: preset.description }),
      })),
    }
  }
}
