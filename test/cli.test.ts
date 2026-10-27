import type { CliIO, HookPlugin } from '../src'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCli, defineHook } from '../src'
import { fakeBuild, payload, place, toyGuard } from './support/toy'

describe('cli', () => {
  const script = fakeBuild()
  let stdout = ''
  let stderr = ''
  const run = async (args: string[], where: { home: string, cwd: string }, io: Partial<CliIO> & { plugin?: HookPlugin } = {}): Promise<number> => {
    stdout = ''
    stderr = ''
    const { plugin = toyGuard(), ...rest } = io
    return createCli(plugin)(args, {
      stdin: () => '',
      script,
      node: 'v22.0.0',
      execPath: process.execPath,
      ...where,
      stdout: (text) => { stdout += text },
      stderr: (text) => { stderr += text },
      ...rest,
    })
  }
  const read = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))
  const entries = (file: string): any[] => read(file).hooks.PreToolUse
  const commandIn = (file: string): string => entries(file).at(-1).hooks[0].command
  const OWN = /^n='.+'; \[ -x "\$n" \] \|\| n=node; "\$n" '.+\/\.toy-guard\/current\/cli\.mjs' hook \|\| exit 2$/
  const scriptOf = (command: string): string => realpathSync(command.slice(command.indexOf(`"$n" '`) + 6, -16))
  // The hook as the agent runs it: through sh, with the tool call on stdin.
  const sh = (command: string, env: Record<string, string>, input = payload('Bash', { command: 'ls' })) => {
    const ran = spawnSync('/bin/sh', ['-c', command], { input, env })
    return { status: ran.status, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() }
  }

  it('installs once, keeps other hooks, and uninstalls', async () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    expect(await run(['install', 'claude'], where)).toBe(0)
    expect(stdout).toBe(`Installed in ${file}\n`)
    const other = { matcher: '*', hooks: [{ type: 'command', command: 'other' }] }
    const settings = read(file)
    settings.hooks.PreToolUse.unshift(other)
    writeFileSync(file, JSON.stringify(settings))
    await run(['install', 'claude'], where)
    expect(entries(file)).toEqual([other, {
      matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
      hooks: [{ type: 'command', command: expect.stringMatching(OWN), timeout: 10, statusMessage: 'Running toy-guard', onFailure: 'block' }],
    }])
    expect(await run(['uninstall', 'claude'], where)).toBe(0)
    expect(stdout).toBe(`Removed from ${file}\n`)
    expect(entries(file)).toEqual([other])
  })

  it('writes the matcher its kinds call for, and tells how Codex trusts a new hook', async () => {
    const where = place()
    await run(['install', 'claude'], where, { plugin: toyGuard(['shell']) })
    expect(entries(join(where.home, '.claude/settings.json'))[0].matcher).toBe('Bash')
    await run(['install', 'codex'], where)
    expect(entries(join(where.home, '.codex/hooks.json'))[0].matcher).toBe('Bash|apply_patch')
    expect(stdout).toContain('open /hooks in Codex')
  })

  it('refuses an agent whose matching tools the check would never see', async () => {
    const where = place()
    expect(await run(['install', 'codex'], where, { plugin: toyGuard(['shell', 'write', 'edit']) })).toBe(1)
    expect(stderr).toContain('add \'patch\' to its kinds')
    expect(await run(['install', 'claude'], where, { plugin: toyGuard(['patch']) })).toBe(1)
    expect(stderr).toContain('which Claude Code does not make')
    expect(existsSync(join(where.home, '.codex'))).toBe(false)
    expect(existsSync(join(where.home, '.claude'))).toBe(false)
  })

  it('replaces every command form an earlier install wrote, and only those', async () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    const plugin = toyGuard(undefined, 'shell-secrets')
    const own = [
      `node '/opt/shell-secrets/cli.mjs' hook`,
      `node '/usr/lib/node_modules/shell-secrets/dist/cli.mjs' hook || exit 2`,
      `n='/usr/bin/node'; [ -x "$n" ] || n=node; "$n" '/home/it'\\''s/.shell-secrets/current/cli.mjs' hook || exit 2`,
      `n='/usr/bin/node'; [ -x "$n" ] || n=node; "$n" '/home/me/.shell-secrets/current/renamed.mjs' hook || exit 2`,
      'npx --no-install shell-secrets hook',
      'npx --no-install shell-secrets hook || exit 2',
    ]
    const others = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/src/shell-secrets-audit/log.sh' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node '/opt/shell-secrets-audit/log.mjs' hook` }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node '/opt/not-shell-secrets/dist/cli.mjs' hook` }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node '/opt/shell-secrets-audit/dist/cli.mjs' hook || exit 2` }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx --no-install shell-secrets-audit hook' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `n='/usr/bin/node'; [ -x "$n" ] || n=node; "$n" '/home/shell-secrets/.guard/current/cli.mjs' hook || exit 2` }] },
      { matcher: 'Bash' },
      { matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'safe?' }] },
    ]
    mkdirSync(dirname(file))
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [...others, ...own.map(command => ({ matcher: 'Bash', hooks: [{ type: 'command', command }] }))] } }))
    await run(['install', 'claude'], where, { plugin })
    expect(entries(file)).toHaveLength(others.length + 1)
    await run(['uninstall', 'claude'], where, { plugin })
    expect(entries(file)).toEqual(others)
  })

  it('refuses, and leaves the file as it is, when the settings are not an object it can extend', async () => {
    for (const text of ['null', '[]', '"x"', '{', '{"hooks": []}', '{"hooks": {"PreToolUse": {}}}']) {
      const where = place()
      const file = join(where.home, '.claude/settings.json')
      mkdirSync(dirname(file))
      writeFileSync(file, text)
      for (const command of ['install', 'uninstall']) {
        expect(await run([command, 'claude'], where), text).toBe(1)
        expect(stderr, text).toContain(file)
        expect(stdout, text).toBe('')
      }
      expect(readFileSync(file, 'utf8'), text).toBe(text)
      expect(existsSync(join(where.home, '.toy-guard')), text).toBe(false)
    }
  })

  it('leaves a config it has nothing to remove from exactly as it was', async () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    mkdirSync(dirname(file))
    for (const text of ['{"model":"x"}', '{"hooks":null}', '{ "hooks": { "PreToolUse": [{ "matcher": "Bash" }] } }']) {
      writeFileSync(file, text)
      expect(await run(['uninstall', 'claude'], where), text).toBe(0)
      expect(readFileSync(file, 'utf8'), text).toBe(text)
    }
  })

  it('writes through a linked config and keeps its mode', async () => {
    const where = place()
    const real = join(where.home, 'dotfiles/settings.json')
    const file = join(where.home, '.claude/settings.json')
    mkdirSync(dirname(real))
    mkdirSync(dirname(file))
    writeFileSync(real, '{"model":"x"}')
    chmodSync(real, 0o600)
    symlinkSync(real, file)
    expect(await run(['install', 'claude'], where)).toBe(0)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(read(real)).toMatchObject({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit' }] } })
    expect(statSync(real).mode & 0o777).toBe(0o600)
    expect(readdirSync(dirname(real))).toEqual(['settings.json'])
  })

  it('prints the usage for an unknown flag or an extra argument instead of picking a scope', async () => {
    for (const args of [['install', 'claude', '--projet'], ['uninstall', 'codex', '--project', 'x'], ['install', 'claude', 'extra']]) {
      const where = place()
      expect(await run(args, where), args.join(' ')).toBe(1)
      expect(stderr).toMatch(/^Usage:/)
      expect(readdirSync(where.home), args.join(' ')).toEqual([])
      expect(readdirSync(where.cwd), args.join(' ')).toEqual([])
    }
  })

  it('writes the hook in when hooks or PreToolUse is null, treating it as absent', async () => {
    for (const text of ['{"hooks": null}', '{"hooks": {"PreToolUse": null}}', '{"other": 1, "hooks": null}']) {
      const where = place()
      const file = join(where.home, '.claude/settings.json')
      mkdirSync(dirname(file))
      writeFileSync(file, text)
      expect(await run(['install', 'claude'], where), text).toBe(0)
      expect(entries(file), text).toHaveLength(1)
      expect(commandIn(file), text).toMatch(OWN)
    }
  })

  it('leaves no config behind when it uninstalls from an agent it never touched', async () => {
    const where = place()
    expect(await run(['uninstall', 'claude'], where)).toBe(0)
    expect(existsSync(join(where.home, '.claude'))).toBe(false)
  })

  it('runs a copy of the build that outlives the package and keeps each build apart', async () => {
    const where = place()
    const from = fakeBuild('one')
    await run(['install', 'claude'], where, { script: from })
    const first = scriptOf(commandIn(join(where.home, '.claude/settings.json')))
    expect(readdirSync(dirname(first)).sort()).toEqual(['chunk.mjs', 'cli.mjs'])
    rmSync(dirname(from), { recursive: true })
    expect(readFileSync(first, 'utf8')).toBe(`import './chunk.mjs' // one`)
    await run(['install', 'codex'], where, { script: fakeBuild('one') })
    expect(commandIn(join(where.home, '.codex/hooks.json'))).toBe(commandIn(join(where.home, '.claude/settings.json')))
    expect(scriptOf(commandIn(join(where.home, '.codex/hooks.json')))).toBe(first)
    await run(['install', 'claude'], where, { script: fakeBuild('two') })
    const second = scriptOf(commandIn(join(where.home, '.claude/settings.json')))
    expect(second).not.toBe(first)
    expect(existsSync(first)).toBe(true)
    expect(readdirSync(join(where.home, '.toy-guard'))).toHaveLength(3)
    rmSync(second)
    await run(['install', 'claude'], where, { script: fakeBuild('two') })
    expect(readFileSync(second, 'utf8')).toBe(`import './chunk.mjs' // two`)
    expect(readdirSync(join(where.home, '.toy-guard'))).toHaveLength(3)
  })

  it('refuses a build whose copy does not run on its own, and keeps the copy already in use', async () => {
    const where = place()
    await run(['install', 'claude'], where)
    const current = readlinkSync(join(where.home, '.toy-guard/current'))
    const unbundled = fakeBuild()
    writeFileSync(unbundled, `import 'agent-kit-missing-package'`)
    expect(await run(['install', 'codex'], where, { script: unbundled })).toBe(1)
    expect(stderr).toContain('does not run on its own')
    expect(stderr).toContain('agent-kit-missing-package')
    expect(readlinkSync(join(where.home, '.toy-guard/current'))).toBe(current)
    expect(existsSync(join(where.home, '.codex'))).toBe(false)
  })

  it('runs on the Node.js that installed it, falls back to PATH once that is gone, and blocks a hook that cannot start', async () => {
    const where = place()
    const nodeDir = mkdtempSync(join(tmpdir(), 'at-node-'))
    symlinkSync(process.execPath, join(nodeDir, 'node'))
    const pathBin = mkdtempSync(join(tmpdir(), 'at-bin-'))
    writeFileSync(join(pathBin, 'node'), '#!/bin/sh\necho path >&2\nexit 1\n', { mode: 0o755 })
    const build = join(mkdtempSync(join(tmpdir(), 'at-build-')), 'cli.mjs')
    writeFileSync(build, 'process.stdout.write(process.argv.slice(2).join(\' \'))\n')
    await run(['install', 'claude'], where, { script: build, execPath: join(nodeDir, 'node') })
    const file = join(where.home, '.claude/settings.json')
    const env = { HOME: where.home, PATH: `${pathBin}:/usr/bin:/bin` }
    expect(sh(commandIn(file), env)).toEqual({ status: 0, stdout: 'hook', stderr: '' })
    rmSync(join(nodeDir, 'node'))
    expect(sh(commandIn(file), env)).toEqual({ status: 2, stdout: '', stderr: 'path\n' })
    expect(entries(file)[0].hooks[0].onFailure).toBe('block')
    await run(['install', 'codex'], where)
    expect(entries(join(where.home, '.codex/hooks.json'))[0].hooks[0]).not.toHaveProperty('onFailure')
  })

  it('quotes a home and a Node.js path holding $ and \'', async () => {
    const root = place()
    const where = { home: join(root.home, 'cost$5', `it's`), cwd: root.cwd }
    mkdirSync(where.home, { recursive: true })
    const nodeDir = join(root.home, `$HOME's node`)
    mkdirSync(nodeDir)
    symlinkSync(process.execPath, join(nodeDir, 'node'))
    const build = join(mkdtempSync(join(tmpdir(), 'at-build-')), 'cli.mjs')
    writeFileSync(build, 'process.stdout.write(process.argv[1])\n')
    expect(await run(['install', 'claude'], where, { script: build, execPath: join(nodeDir, 'node') })).toBe(0)
    const ran = sh(commandIn(join(where.home, '.claude/settings.json')), { PATH: '/nonexistent' })
    expect(ran).toEqual({ status: 0, stdout: join(where.home, '.toy-guard/current/cli.mjs'), stderr: '' })
  })

  it('names the package in a project install, and blocks where npx or the package is missing', async () => {
    const where = place()
    expect(await run(['install', 'codex', '--project'], where, {})).toBe(0)
    const file = join(where.cwd, '.codex/hooks.json')
    expect(commandIn(file)).toBe('npx --no-install toy-guard hook || exit 2')
    expect(sh(commandIn(file), { PATH: '/nonexistent' }).status).toBe(2)
    expect(existsSync(join(where.home, '.codex'))).toBe(false)
    expect(existsSync(join(where.home, '.toy-guard'))).toBe(false)
    expect(await run(['uninstall', 'codex', '--project'], where)).toBe(0)
    expect(read(file).hooks.PreToolUse).toBeUndefined()
  })

  it('refuses to replace a current that is not its link, and leaves no temporary link behind', async () => {
    const where = place()
    mkdirSync(join(where.home, '.toy-guard/current'), { recursive: true })
    expect(await run(['install', 'claude'], where)).toBe(1)
    expect(stderr).toContain('is not the link install writes')
    expect(readdirSync(join(where.home, '.toy-guard')).filter(name => name.startsWith('current'))).toEqual(['current'])
    expect(existsSync(join(where.home, '.claude'))).toBe(false)
  })

  it('refuses to install from an entry that is not a build', async () => {
    const where = place()
    expect(await run(['install', 'claude'], where, { script: join(dirname(script), 'cli.ts') })).toBe(1)
    expect(await run(['install', 'claude'], where, { script: join(dirname(script), 'missing.mjs') })).toBe(1)
    expect(existsSync(join(where.home, '.claude'))).toBe(false)
  })

  it('runs the hook on the tool call from stdin, in the given working directory', async () => {
    const where = place()
    expect(await run(['hook'], where, { stdin: () => payload('Bash', { command: 'echo FORBIDDEN' }) })).toBe(2)
    expect(stderr).toBe('toy-guard: FORBIDDEN is not allowed\n')
    expect(await run(['hook'], where, { stdin: () => '' })).toBe(2)
    const seen: string[] = []
    const plugin = defineHook({ name: 'cwd-seer', kinds: ['shell'], check: (_, { cwd }) => {
      seen.push(cwd)
      return { block: false }
    } })
    expect(await run(['hook'], where, { plugin, stdin: () => payload('Bash', { command: 'ls' }) })).toBe(0)
    expect(seen).toEqual([where.cwd])
  })

  it('blocks the hook and refuses to install on a Node.js older than 22, and still uninstalls', async () => {
    const where = place()
    const clean = () => payload('Bash', { command: 'ls' })
    expect(await run(['hook'], where, { stdin: clean, node: 'v20.20.2' })).toBe(2)
    expect(stderr).toContain('Node.js 22 or later')
    expect(await run(['install', 'claude'], where, { node: 'v18.20.6' })).toBe(1)
    expect(existsSync(join(where.home, '.claude'))).toBe(false)
    expect(await run(['hook'], where, { stdin: clean, node: 'node' })).toBe(2)
    expect(await run(['hook'], where, { stdin: clean, node: 'v22.13.1' })).toBe(0)
    await run(['install', 'claude'], where, { node: 'v22.13.1' })
    expect(await run(['uninstall', 'claude'], where, { node: 'v20.20.2' })).toBe(0)
    expect(read(join(where.home, '.claude/settings.json')).hooks.PreToolUse).toBeUndefined()
  })

  it('prints the usage for anything else', async () => {
    const where = place()
    for (const args of [[], ['instal', 'claude'], ['install'], ['install', 'cursor']]) {
      expect(await run(args, where), args.join(' ')).toBe(1)
      expect(stderr).toBe([
        'Usage:',
        '  toy-guard install <claude|codex> [--project]   add the PreToolUse hook',
        '  toy-guard uninstall <claude|codex> [--project] remove it',
        '  toy-guard hook                                 run as the hook (reads the tool call on stdin)',
        '',
      ].join('\n'))
    }
  })
})
