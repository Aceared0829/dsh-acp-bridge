window.__ModuleLoader__.load({
  id: 'dsh-acp-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The panel talks to its own Host routes, so the base is derived once. */
    const PREFIX = '/dsh-acp-bridge'
    const PANEL_URL = `${PREFIX}panel`
    const ACTION_URL = `${PREFIX}action`
    const POLL_MS = 2500

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '18px 20px 28px',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        minWidth: 0,
      },
      header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 17, fontWeight: 700, margin: 0 },
      sub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5 },
      dot: (on) => ({
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: on ? 'var(--color-green-500, #3fb950)' : 'var(--dsw-alias-label-tertiary)',
        display: 'inline-block',
      }),
      statRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 },
      stat: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 9,
        padding: '9px 11px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
      },
      statLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      statValue: { fontSize: 21, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
      sectionLabel: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        textAlign: 'left',
        padding: '5px 8px',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 600,
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
      td: {
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
        verticalAlign: 'middle',
      },
      mono: { fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: 11 },
      button: {
        font: 'inherit',
        fontSize: 11.5,
        padding: '3px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      danger: { color: 'var(--color-red-500, #d16060)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 9,
        padding: '11px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
      },
      code: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: 11,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 6,
        padding: '7px 9px',
        margin: 0,
      },
      traffic: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: 10.5,
        lineHeight: 1.65,
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 6,
        padding: '7px 9px',
        maxHeight: 180,
        overflow: 'auto',
        margin: 0,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 0 },
      empty: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, padding: '6px 0' },
    }

    /** A tiny labelled number tile. */
    function Stat(props) {
      return h('div', { style: styles.stat }, [
        h('span', { key: 'l', style: styles.statLabel }, props.label),
        h('span', { key: 'v', style: styles.statValue }, props.value),
        props.note ? h('span', { key: 'n', style: styles.statLabel }, props.note) : null,
      ])
    }

    /** One switch row for an exposed capability. */
    function ExposeRow(props) {
      const on = props.enabled
      return h(
        'div',
        { style: { ...styles.row, justifyContent: 'space-between', fontSize: 12 } },
        [
          h('span', { key: 'k', style: styles.grow }, [
            h('span', { key: 'n', style: { fontFamily: 'var(--ds-font-family-code, monospace)' } }, props.name),
            h('span', { key: 'd', style: { color: 'var(--dsw-alias-label-secondary)', marginLeft: 8 } }, props.desc),
          ]),
          h(
            'span',
            {
              key: 's',
              title: on ? 'Advertised' : 'Not advertised',
              style: {
                width: 30,
                height: 16,
                borderRadius: 8,
                background: on ? 'var(--color-green-600, #2f7d4f)' : 'var(--dsw-alias-bg-layer-3, #3a4150)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: on ? 'flex-end' : 'flex-start',
                padding: 2,
                boxSizing: 'border-box',
              },
            },
            h('span', {
              style: {
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: on ? '#c9f2d8' : 'var(--dsw-alias-label-tertiary)',
              },
            }),
          ),
        ],
      )
    }

    /** The ACP page: connection health, live sessions, capability switches. */
    function AcpPanel() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        let live = true
        let timer
        const pull = async () => {
          try {
            const response = await fetch(PANEL_URL, { credentials: 'include' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const next = await response.json()
            if (live) {
              setState(next)
              setError(null)
            }
          } catch (failure) {
            if (live) setError(failure.message)
          } finally {
            if (live) timer = setTimeout(pull, POLL_MS)
          }
        }
        void pull()
        return () => {
          live = false
          clearTimeout(timer)
        }
      }, [])

      const act = React.useCallback(async (body) => {
        try {
          await fetch(ACTION_URL, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        } catch {
          // The next poll shows the authoritative state.
        }
      }, [])

      const copy = React.useCallback(async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          // Clipboard permission is the browser's decision; leave it silent.
        }
      }, [])

      if (state === null) {
        return h('div', { style: styles.root }, h('div', { style: styles.empty }, error ?? 'Loading…'))
      }

      const running = state.sessions.filter((row) => row.state === 'running').length
      const waiting = state.approvals.length

      return h('div', { style: styles.root }, [
        h('div', { key: 'head', style: styles.header }, [
          h('h2', { key: 't', style: styles.title }, 'ACP Bridge'),
          h('span', { key: 'd', style: styles.dot(state.enabled && state.listening) }),
          h('span', { key: 's', style: styles.sub }, state.enabled && state.listening ? 'Listening' : 'Stopped'),
          h('code', { key: 'u', style: { ...styles.mono, color: 'var(--dsw-alias-label-secondary)' } }, state.websocket),
        ]),

        h('div', { key: 'stats', style: styles.statRow }, [
          h(Stat, { key: 'c', label: 'Connections', value: state.connections.length }),
          h(Stat, {
            key: 's',
            label: 'ACP sessions',
            value: state.sessions.length,
            note: running > 0 ? `${running} running` : undefined,
          }),
          h(Stat, { key: 'a', label: 'Pending approvals', value: waiting }),
        ]),

        waiting > 0
          ? h('div', { key: 'appr', style: styles.card }, [
              h('span', { key: 'l', style: styles.sectionLabel }, 'Pending approvals'),
              h(
                'span',
                { key: 'h', style: styles.sub },
                'Answered here when the client cannot. Unanswered requests are rejected when the timeout expires.',
              ),
              ...state.approvals.map((item) =>
                h('div', { key: item.callId ?? item.id, style: styles.row }, [
                  h('span', { key: 'n', style: { ...styles.mono, flex: 1 } }, `${item.toolName ?? 'tool'} · ${item.reason ?? ''}`),
                  h(
                    'button',
                    { key: 'y', style: styles.button, onClick: () => act({ action: 'approve', sessionId: item.id }) },
                    'Allow once',
                  ),
                  h(
                    'button',
                    { key: 'n2', style: { ...styles.button, ...styles.danger }, onClick: () => act({ action: 'reject', sessionId: item.id }) },
                    'Reject',
                  ),
                ]),
              ),
            ])
          : null,

        h('span', { key: 'sl', style: styles.sectionLabel }, 'Sessions'),
        state.sessions.length === 0
          ? h('div', { key: 'none', style: styles.empty }, 'No ACP client is connected yet.')
          : h(
              'table',
              { key: 'table', style: styles.table },
              [
                h('thead', { key: 'h' }, h('tr', {}, [
                  h('th', { key: 'c', style: styles.th }, 'Client'),
                  h('th', { key: 'w', style: styles.th }, 'Working directory'),
                  h('th', { key: 'm', style: styles.th }, 'Mode'),
                  h('th', { key: 'mo', style: styles.th }, 'Model'),
                  h('th', { key: 'e', style: styles.th }, 'Effort'),
                  h('th', { key: 's', style: styles.th }, 'State'),
                  h('th', { key: 'a', style: styles.th }, 'Actions'),
                ])),
                h(
                  'tbody',
                  { key: 'b' },
                  state.sessions.map((row) =>
                    h('tr', { key: row.sessionId }, [
                      h('td', { key: 'c', style: styles.td }, 'ACP'),
                      h('td', { key: 'w', style: { ...styles.td, ...styles.mono } }, row.cwd),
                      h('td', { key: 'm', style: styles.td }, row.mode || '—'),
                      h('td', { key: 'mo', style: styles.td }, row.model || '—'),
                      h('td', { key: 'e', style: styles.td }, row.effort || '—'),
                      h('td', { key: 's', style: styles.td }, row.state),
                      h(
                        'td',
                        { key: 'a', style: styles.td },
                        h(
                          'button',
                          {
                            style: { ...styles.button, ...styles.danger },
                            onClick: () => act({ action: 'kick', sessionId: row.sessionId }),
                          },
                          'Disconnect',
                        ),
                      ),
                    ]),
                  ),
                ),
              ],
            ),

        h('span', { key: 'el', style: styles.sectionLabel }, 'Options exposed to clients'),
        h(
          'div',
          { key: 'expose', style: styles.card },
          [
            h(ExposeRow, { key: 'model', name: 'model', desc: 'provider/model selector', enabled: state.expose.model }),
            h(ExposeRow, { key: 'r', name: 'reasoning_effort', desc: 'thought level', enabled: state.expose.reasoning }),
            h(ExposeRow, { key: 'm', name: 'mode', desc: 'agent preset', enabled: state.expose.mode }),
            h(ExposeRow, { key: 'p', name: '_dsh_permission', desc: 'approval policy', enabled: state.expose.permission }),
            h(ExposeRow, { key: 'c', name: '_dsh_commands', desc: 'slash commands', enabled: state.expose.commands }),
            h(ExposeRow, { key: 'pl', name: '_dsh_plan', desc: 'plan reporting', enabled: state.expose.plan }),
            h(ExposeRow, { key: 'u', name: '_dsh_usage', desc: 'context usage', enabled: state.expose.usage }),
            h(ExposeRow, { key: 'i', name: '_dsh_image_input', desc: 'inline images', enabled: state.expose.images }),
            h('span', { key: 'hint', style: styles.sub }, 'A disabled option is not advertised, so clients never see it.'),
          ],
        ),

        h('span', { key: 'll', style: styles.sectionLabel }, 'Client setup'),
        h('div', { key: 'launch', style: styles.card }, [
          h('pre', { key: 'c', style: styles.code }, state.launcher.shell),
          h('div', { key: 'r', style: styles.row }, [
            h(
              'button',
              { key: 'b', style: styles.button, onClick: () => copy(state.launcher.shell) },
              copied ? 'Copied' : 'Copy',
            ),
            h('span', { key: 't', style: styles.sub }, 'Point your ACP client at this command.'),
          ]),
        ]),

        h('span', { key: 'tl', style: styles.sectionLabel }, 'Recent traffic'),
        h('pre', { key: 'traffic', style: styles.traffic },
          state.traffic.length === 0
            ? 'Nothing yet.'
            : state.traffic
                .map((frame) => `${frame.direction === 'in' ? '→' : '←'} ${frame.method}  ${frame.detail ?? ''}`)
                .join('\n'),
        ),
      ])
    }

    /** A composer chip showing which ACP client drives the current session. */
    function AcpChip() {
      const [active, setActive] = React.useState(false)
      React.useEffect(() => {
        let live = true
        const timer = setInterval(async () => {
          try {
            const response = await fetch(PANEL_URL, { credentials: 'include' })
            if (!response.ok) return
            const next = await response.json()
            if (live) setActive(next.sessions.length > 0)
          } catch {
            // Leave the chip in its current state.
          }
        }, POLL_MS * 2)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [])
      if (!active) return null
      return h(
        'span',
        {
          title: 'This session may be driven by an external ACP client.',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 9px',
            borderRadius: 999,
            border: '1px solid var(--dsw-alias-border-l2)',
            fontSize: 11,
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
        [h('span', { key: 'd', style: styles.dot(true) }), h('span', { key: 't' }, 'ACP')],
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'acp-bridge' }, AcpPanel),
        )
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: 'acp-bridge-chip', order: 40 }, AcpChip),
        )
      },
    }
  },
})
