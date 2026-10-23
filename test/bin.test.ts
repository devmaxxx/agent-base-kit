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
