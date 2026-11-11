# dsh-acp-bridge

Serve a running [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) over the
[Agent Client Protocol](https://agentclientprotocol.com) so that any ACP client — Zed, Neovim,
JetBrains, Emacs, or your own script — can drive **this app's** agent loop, model selection,
reasoning effort and agent presets, with a management panel inside the Harness Web UI.

The agent does not move. The sessions, tools, model routing and history stay in the Harness
process you already have open; the client is a remote control.

## Why a shim is unavoidable

ACP v1 defines exactly one transport: the client spawns a subprocess and the two sides exchange
newline-delimited JSON-RPC over stdin/stdout. Editors therefore cannot dial a port — they can only
launch a command. This package ships that command (`dsh-acp-stdio`), which forwards each frame to a
WebSocket the Harness already serves.

```
Zed / Neovim / script
        │  spawn, NDJSON on stdio
        ▼
  dsh-acp-stdio ──── WebSocket ────► dsh-acp-bridge (Host)
                                          │ in-process
                                          ▼
                                   ctx.agents · ctx.llm · ctx.agentPresets …
```

One Harness, many clients: a session opened in Zed shows up in the ACP panel, and can be inspected
or disconnected from there.

## Install

```bash
# from a checkout of this package
dsh plugin install /absolute/path/to/dsh-acp-bridge --profile desktop
```

Or add it to a profile's bundle list and let the plugin manager install it. The bundle inserts one
Host row; the panel is loaded through `dsh.client` in `package.json`.

## What it exposes

### Standard ACP config options

| Option | Category | Source | Takes effect |
|---|---|---|---|
| `model` | `model` | live `llm.listProviders()` × `listModels()`, grouped by provider | the next model step |
| `reasoning_effort` | `thought_level` | `resolveModelInfo().reasoning`, with a "provider default" sentinel | the next model step |
| `mode` | `mode` | the `agentPresets` roster (also mirrored into ACP's legacy `modes`) | **before the first turn only** |

`mode` is exactly the agent-preset mechanism: a preset fixes the tool set, system prompt and
permission policy together. The Harness only allows that swap on a blank session, so changing it
after the first turn is rejected with a correctable error rather than silently ignored.

### Extension options (`_dsh_` prefix)

The spec reserves `_`-prefixed category names for implementations, and clients that do not
recognise one ignore it and keep the `currentValue` — so these are safe to always advertise:

| Option | Effect |
|---|---|
| `_dsh_permission` | approval policy (`ask` / `never`) bound to `ctx.approval.setPolicy` |

### Session methods

`initialize` · `session/new` · `session/resume` · `session/list` · `session/delete` ·
`session/close` · `session/set_config_option` · `session/set_mode` · `session/prompt` ·
`session/cancel` · `session/update` · `session/request_permission`

Committed assistant messages, reasoning, tool lifecycle and context usage are projected from the
durable session log — not from a provider stream — so a reconnecting or second client always sees
the same truth. Slash commands from the Harness registry are published as `available_commands`.

### Deliberately not exposed

DSH-specific presentation (genui cards, action cards, team tasks) has no ACP counterpart and stays
off the wire; forcing it in would corrupt the protocol. `session/load` transcript replay is not
implemented.

## Approvals

A tool that needs confirmation asks the **client** first, over `session/request_permission`.

If the client cannot answer — no permission UI, a dropped socket, a headless script — the request is
**parked** and appears in the ACP panel, where you can allow or reject it. Anything still unanswered
when `approvalTimeoutMs` expires is **rejected**: an unattended Agent never grants itself a tool call
by default.

## Panel

A page in the Harness sidebar (`ACP`), plus a small chip in the composer tool row:

- connection and session counts, pending approvals
- live session table: working directory, preset, model, effort, state, disconnect
- which capabilities are advertised (mirrors the `expose` config)
- a copy-paste client snippet for the current port and token
- recent desensitized JSON-RPC frames

The panel holds no protocol logic — it is observation and control over the same objects the bridge
already owns, and "disconnect" runs the exact same disposer a client exit does.

## Configuration

Set on the plugin row (see `cordis.patch.yml` for the defaults):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | serve the endpoint at all |
| `path` | `/dsh-acp-bridge` | URL prefix for the ACP endpoints and the panel API |
| `host` | `127.0.0.1` | host recorded in client snippets |
| `provider` / `model` | `''` | fallback route for new sessions |
| `approvalTimeoutMs` | `120000` | how long a parked approval waits before it is rejected |
| `requireToken` | `true` | require the generated bearer token |
| `expose.*` | see file | which capabilities are advertised |

The access token is generated once and stored in `~/.dsh/acp-bridge/token` (mode `0600`), never in
`cordis.patch.yml`. Rotate it from the panel.

## Point a client at it

The panel shows the exact snippet. For Zed, `settings.json`:

```json
{
  "agent_servers": {
    "dsh": {
      "command": {
        "path": "npx",
        "args": ["dsh-acp-stdio", "--url", "ws://127.0.0.1:PORT/dsh-acp-bridge/ws", "--token", "TOKEN"]
      }
    }
  }
}
```

Or run the shim yourself and pipe frames through it:

```bash
npx dsh-acp-stdio --url ws://127.0.0.1:PORT/dsh-acp-bridge/ws --token TOKEN
```

Streamable HTTP is served on the same prefix for clients that speak it directly.

## Notes on the internals

- Transport is delegated to `@agentclientprotocol/sdk`'s `AcpServer`: it validates params, shapes
  responses and owns the connection registry. This package wires carriers and translates payloads.
- The shim parses nothing. It cannot drift from the protocol because it never interprets a frame.
- A profile-installed plugin cannot import `@deepseek-ai/dsh-llm` or `@deepseek-ai/dsh-agent` —
  the profile does not carry those packages — so the bridge builds the user message record it needs
  instead of importing `createUserMessage`, and skips the optional model-switch notice.

## Development

```bash
npm install
npm test        # unit + end-to-end transport tests
```

The transport test stands up the real SDK server behind a real HTTP listener and drives a real
WebSocket client through the handshake, so a wiring regression fails there rather than in an editor.

## License

MIT
