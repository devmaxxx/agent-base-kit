import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { payload, place } from './support/toy'

// The toy plugin's bin, built with the toolkit bundled in by the global setup.
const built = join(import.meta.dirname, 'fixtures/dist/toy-bin.mjs')

describe('a plugin bin built on runCli', () => {
  const hook = (input: string, bin = built) => {
    const ran = spawnSync(process.execPath, [bin, 'hook'], { input })
    return { status: ran.status, stderr: ran.stderr.toString() }
  }

  it('reads a payload larger than one pipe buffer', () => {
    const content = `${'x\n'.repeat(40_000)}FORBIDDEN`
    expect(hook(payload('Write', { file_path: 'a.js', content }))).toEqual({ status: 2, stderr: 'toy-bin: FORBIDDEN is not allowed\n' })
    expect(hook(payload('Write', { file_path: 'a.js', content: 'x\n'.repeat(40_000) })).status).toBe(0)
  })

  it('blocks a check whose promise never settles instead of exiting 0', () => {
    expect(hook(payload('Bash', { command: 'HANG' }))).toEqual({ status: 2, stderr: 'Blocked by toy-bin, its check never finished\n' })
  })

  it('lets a reply pass when its Stop check never settles, and blocks one through stdout', () => {
    const stop = (reply: string) => spawnSync(process.execPath, [built, 'hook'], { input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: reply }) })
    const hung = stop('HANG')
    expect({ status: hung.status, stderr: hung.stderr.toString() }).toEqual({ status: 0, stderr: 'toy-bin let it pass, its check never finished\n' })
    const blocked = stop('FORBIDDEN')
    expect(blocked.status).toBe(0)
    expect(JSON.parse(blocked.stdout.toString())).toEqual({ decision: 'block', reason: 'toy-bin: take FORBIDDEN out of the reply' })
  })

  it('lets a reply pass on a payload cut short or a check that never settles when told the event is Stop', () => {
    const told = (event: string, input: string) => {
      const ran = spawnSync(process.execPath, [built, 'hook', '--event', event, '--agent', 'claude'], { input })
      return { status: ran.status, stderr: ran.stderr.toString() }
    }
    expect(told('Stop', '{"hook_event_name":"Stop","last_assistant_message":"FORBI')).toMatchObject({ status: 0, stderr: expect.stringContaining('let it pass') })
    expect(told('Stop', JSON.stringify({ last_assistant_message: 'HANG' }))).toEqual({ status: 0, stderr: 'toy-bin let it pass, its check never finished\n' })
    expect(told('PreToolUse', '{"hook_event_name":"PreToolUse","tool_name":"Ba').status).toBe(2)
    expect(hook('{"hook_event_name":"Stop","last_assistant_message":"FORBI').status).toBe(2)
  })

  it('installs commands that pass a cut-short Stop payload and block a cut-short tool call', () => {
    const where = place()
    const env = { ...process.env, HOME: where.home }
    expect(spawnSync(process.execPath, [built, 'install', 'claude'], { cwd: where.cwd, env }).status).toBe(0)
    const { hooks } = JSON.parse(readFileSync(join(where.home, '.claude/settings.json'), 'utf8'))
    const sh = (command: string, input: string) => spawnSync('/bin/sh', ['-c', command], { input, env: { PATH: '/usr/bin:/bin' } }).status
    expect(sh(hooks.Stop[0].hooks[0].command, '{"hook_event_name":"Stop","last_assis')).toBe(0)
    expect(sh(hooks.PreToolUse[0].hooks[0].command, '{"hook_event_name":"PreToolUse","tool_na')).toBe(2)
  })

  it('installs a hook that keeps working after the package it came from is gone', () => {
    const where = place()
    const pkg = mkdtempSync(join(tmpdir(), 'at-pkg-'))
    cpSync(join(built, '..'), pkg, { recursive: true })
    const env = { ...process.env, HOME: where.home }
    const install = spawnSync(process.execPath, [join(pkg, 'toy-bin.mjs'), 'install', 'claude'], { cwd: where.cwd, env })
    const file = join(where.home, '.claude/settings.json')
    expect(install.stdout.toString()).toBe(`Installed in ${file}\n`)
    expect(install.status).toBe(0)
    rmSync(pkg, { recursive: true })
    const { command } = JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse[0].hooks[0]
    const sh = (input: string) => spawnSync('/bin/sh', ['-c', command], { input, env: { PATH: '/usr/bin:/bin' } })
    expect(sh(payload('Bash', { command: 'echo FORBIDDEN' })).status).toBe(2)
    expect(sh(payload('Bash', { command: 'ls' })).status).toBe(0)
  })
})
