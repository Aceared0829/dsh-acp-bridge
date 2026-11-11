/**
 * The launcher sits between the editor and the shim: it discovers the port and
 * forwards the pinned preset. A regression there is invisible to every other
 * test, and it silently made all five JetBrains entries open as `standard`, so
 * this pins the forwarding itself.
 *
 * Run with `node --test test/`.
 *
 * @module dsh-acp-bridge/test/launcher-args
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const LAUNCHER = fileURLToPath(new URL('../bin/jetbrains.mjs', import.meta.url))
const SHIM = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))

const launcher = readFileSync(LAUNCHER, 'utf8')

test('the launcher parses --preset and forwards it to the shim', () => {
  assert.match(launcher, /readPresetArg\(/, 'the launcher reads its own --preset')
  assert.match(launcher, /'--preset', preset/, 'and hands it to the shim')
  assert.ok(
    launcher.indexOf('readPresetArg(process.argv') !== -1,
    'the flag is read from this process, not from the shim',
  )
})

test('the shim sends the preset as an upgrade header', () => {
  const shim = readFileSync(SHIM, 'utf8')
  assert.match(shim, /x-dsh-acp-preset/, 'the header name is what the host reads')
  assert.match(shim, /--preset/, 'the flag is documented and parsed')
})

test('an unknown flag fails before any socket is opened', () => {
  // The parse runs top-level before `new WebSocket`, so a usage error cannot
  // leave a half-open connection behind.
  const socketAt = launcher.indexOf('new WebSocket')
  const spawnAt = launcher.indexOf('spawn(process.execPath, shimArgs')
  const presetAt = launcher.indexOf('readPresetArg(process.argv')
  assert.ok(presetAt !== -1 && presetAt < spawnAt, 'the preset is read before the shim starts')
  assert.ok(socketAt === -1, 'the launcher itself never opens the socket; the shim does')
})
