import type { CliIO, HookDefinition, HookPlugin, InstallPlace, ToolCall, ToolKind } from '../src'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudePluginFiles, createCli, defineHook, runHook } from '../src'
import { fakeBuild, payload, place } from './support/toy'

const MCP = 'mcp__forge__create_pull_request'

// Blocks FORBIDDEN at every event it takes part in.
function guard(extra: Partial<HookDefinition<ToolKind>> = {}): HookPlugin {
  const verdict = (text: string, where: string) => text.includes('FORBIDDEN') ? { block: true as const, reason: `guard: FORBIDDEN in the ${where}` } : { block: false as const }
  return defineHook({
    name: 'guard',
    kinds: ['shell', 'write', 'edit', 'patch'],
    check: call => verdict(JSON.stringify(call), 'call'),
    events: {
      Stop: { check: ({ reply }) => verdict(reply, 'reply') },
      UserPromptSubmit: { check: ({ prompt }) => verdict(prompt, 'prompt'), hidePrompt: true, statusMessage: 'Checking the prompt', timeout: 3 },
    },
    ...extra,
  })
}

const event = (hook_event_name: string, fields: Record<string, unknown>): string => JSON.stringify({ hook_event_name, ...fields })

async function hook(plugin: HookPlugin, input: string): Promise<{ code: number, stdout: string, stderr: string }> {
  const out = { stdout: '', stderr: '' }
  const code = await runHook(plugin, input, {
    cwd: '/fallback',
    stdout: (text) => { out.stdout += text },
    stderr: (text) => { out.stderr += text },
  })
  return { code, ...out }
}

describe('a Stop check', () => {
  it('blocks a reply through stdout and exits 0, and passes a clean one silently', async () => {
    expect(await hook(guard(), event('Stop', { last_assistant_message: 'FORBIDDEN' }))).toEqual({
      code: 0,
      stdout: `${JSON.stringify({ decision: 'block', reason: 'guard: FORBIDDEN in the reply' })}\n`,
      stderr: '',
    })
    expect(await hook(guard(), event('Stop', { last_assistant_message: 'done' }))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('does not check the reply its own block produced', async () => {
    let calls = 0
    const plugin = guard({ events: { Stop: { check: () => {
      calls++
      return { block: true, reason: 'again' }
    } } } })
    expect(await hook(plugin, event('Stop', { last_assistant_message: 'x', stop_hook_active: true }))).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(calls).toBe(0)
  })

  it('lets the reply pass, saying why, when the check throws, returns no verdict or gets a reply of the wrong shape', async () => {
    const throws = guard({ events: { Stop: { check: () => {
      throw new Error('boom')
    } } } })
    const noVerdict = guard({ events: { Stop: { check: () => 'yes' as never } } })
    for (const [plugin, input] of [[throws, 'x'], [noVerdict, 'x'], [guard(), ['FORBIDDEN']]] as const) {
      const ran = await hook(plugin, event('Stop', { last_assistant_message: input }))
      expect(ran).toMatchObject({ code: 0, stdout: '' })
      expect(ran.stderr).toMatch(/^guard could not check the reply, so it let it pass: /)
    }
  })

  it('hands the check the payload cwd, else the fallback, and an absent reply as empty', async () => {
    const seen: unknown[] = []
    const plugin = guard({ events: { Stop: { check: (input, context) => {
      seen.push([input, context])
      return { block: false }
    } } } })
    await hook(plugin, event('Stop', { last_assistant_message: 'a', cwd: '/p' }))
    await hook(plugin, event('Stop', {}))
    expect(seen).toEqual([[{ reply: 'a' }, { cwd: '/p' }], [{ reply: '' }, { cwd: '/fallback' }]])
  })
})

describe('a UserPromptSubmit check', () => {
  it('blocks a prompt through stdout, asking Claude Code not to print it back when hidePrompt is set', async () => {
    expect(JSON.parse((await hook(guard(), event('UserPromptSubmit', { prompt: 'FORBIDDEN' }))).stdout)).toEqual({
      decision: 'block',
      reason: 'guard: FORBIDDEN in the prompt',
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    })
    const shown = guard({ events: { UserPromptSubmit: { check: () => ({ block: true, reason: 'no' }) } } })
    expect(await hook(shown, event('UserPromptSubmit', { prompt: 'x' }))).toEqual({ code: 0, stdout: `${JSON.stringify({ decision: 'block', reason: 'no' })}\n`, stderr: '' })
  })

  it('lets the prompt pass when the check throws', async () => {
    const plugin = guard({ events: { UserPromptSubmit: { check: async () => Promise.reject(new Error('down')) } } })
    expect(await hook(plugin, event('UserPromptSubmit', { prompt: 'x' }))).toEqual({ code: 0, stdout: '', stderr: 'guard could not check the prompt, so it let it pass: down\n' })
  })
})

describe('events the plugin does not check', () => {
  it('pass Stop and UserPromptSubmit, and any event other than PreToolUse, unchecked', async () => {
    const plain = guard({ events: {} })
    for (const input of [event('Stop', { last_assistant_message: 'FORBIDDEN' }), event('UserPromptSubmit', { prompt: 'FORBIDDEN' }), event('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'FORBIDDEN' } })])
      expect(await hook(plain, input), input).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('still read a payload naming PreToolUse, or no event, as a tool call that fails closed', async () => {
    expect((await hook(guard(), payload('Bash', { command: 'FORBIDDEN' }))).code).toBe(2)
    expect((await hook(guard(), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'FORBIDDEN' } }))).code).toBe(2)
    expect((await hook(guard(), event('PreToolUse', {}))).code).toBe(2)
  })
})

describe('named tools', () => {
  const recording = (tools: readonly string[] = [MCP]) => {
    const seen: ToolCall[] = []
    const plugin = defineHook({ name: 'guard', kinds: ['shell', 'tool'], tools, check: (call) => {
      seen.push(call)
      return call.kind === 'tool' && JSON.stringify(call.input).includes('FORBIDDEN') ? { block: true, reason: 'guard: no' } : { block: false }
    } })
    return { plugin, seen }
  }

  it('hands the check a listed tool with its input, and skips one it did not list', async () => {
    const { plugin, seen } = recording()
    expect((await hook(plugin, payload(MCP, { title: 'FORBIDDEN', n: 1 }))).code).toBe(2)
    expect((await hook(plugin, payload(MCP, undefined))).code).toBe(0)
    expect((await hook(plugin, payload('mcp__forge__merge_pull_request', { title: 'FORBIDDEN' }))).code).toBe(0)
    expect(seen).toEqual([{ kind: 'tool', name: MCP, input: { title: 'FORBIDDEN', n: 1 } }, { kind: 'tool', name: MCP, input: {} }])
  })

  it('blocks a listed tool whose input is not an object', async () => {
    for (const input of ['x', [1], 3]) {
      const ran = await hook(recording().plugin, payload(MCP, input))
      expect(ran.code).toBe(2)
      expect(ran.stderr).toBe('Blocked by guard, it could not check the call: tool_input is not an object\n')
    }
  })

  it('adds the tools to both agents\' matchers, after the agent\'s own', () => {
    const { plugin } = recording([MCP, 'mcp__forge__add_comment', MCP])
    expect(plugin.tools).toEqual([MCP, 'mcp__forge__add_comment'])
    expect(JSON.parse(claudePluginFiles({ plugin, entry: 'dist/cli.mjs' })['hooks/hooks.json']!).hooks.PreToolUse[0].matcher).toBe(`Bash|${MCP}|mcp__forge__add_comment`)
    const toolsOnly = defineHook({ name: 'guard', kinds: ['tool'], tools: [MCP], check: () => ({ block: false }) })
    expect(JSON.parse(claudePluginFiles({ plugin: toolsOnly, entry: 'dist/cli.mjs' })['hooks/hooks.json']!).hooks.PreToolUse[0].matcher).toBe(MCP)
  })

  it('refuses a tool name a matcher would read as a pattern, an agent\'s own tool, and a tool kind without tools or tools without it', () => {
    const base = { name: 'guard', check: () => ({ block: false as const }) }
    expect(() => defineHook({ ...base, kinds: ['tool'], tools: ['mcp__a|b'] })).toThrow(/^tools must list tool names/)
    expect(() => defineHook({ ...base, kinds: ['tool'], tools: [''] })).toThrow(/^tools must list tool names/)
    expect(() => defineHook({ ...base, kinds: ['tool'], tools: 'mcp__a' as never })).toThrow(/^tools must list tool names/)
    expect(() => defineHook({ ...base, kinds: ['tool'], tools: ['Bash'] })).toThrow('Bash is one of the agents\' own tools; list its kind instead')
    expect(() => defineHook({ ...base, kinds: ['tool'] })).toThrow(/^kinds lists tool exactly when/)
    expect(() => defineHook({ ...base, kinds: ['shell'], tools: [MCP] })).toThrow(/^kinds lists tool exactly when/)
  })
})

describe('defineHook events', () => {
  const base = { name: 'guard', kinds: ['shell'] as const, check: () => ({ block: false as const }), statusMessage: 'Guarding', timeout: 7 }

  it('fills an event\'s status message and timeout from the hook\'s, and hidePrompt as false', () => {
    const plugin = defineHook({ ...base, events: { Stop: { check: () => ({ block: false }) }, UserPromptSubmit: { check: () => ({ block: false }), timeout: 2 } } })
    expect(plugin.events.Stop).toMatchObject({ statusMessage: 'Guarding', timeout: 7 })
    expect(plugin.events.UserPromptSubmit).toMatchObject({ statusMessage: 'Guarding', timeout: 2, hidePrompt: false })
    expect(defineHook(base).events).toEqual({})
  })

  it('refuses an event it does not run, an event without a check, and a bad status, timeout or hidePrompt', () => {
    const ok = { check: () => ({ block: false as const }) }
    expect(() => defineHook({ ...base, events: { PostToolUse: ok } as never })).toThrow('events.PostToolUse is not one of Stop, UserPromptSubmit')
    expect(() => defineHook({ ...base, events: [] as never })).toThrow('events is not an object')
    expect(() => defineHook({ ...base, events: { Stop: {} as never } })).toThrow('events.Stop.check is not a function')
    expect(() => defineHook({ ...base, events: { Stop: { ...ok, timeout: 0 } } })).toThrow(/^events\.Stop\.timeout /)
    expect(() => defineHook({ ...base, events: { Stop: { ...ok, statusMessage: '' } } })).toThrow(/^events\.Stop\.statusMessage /)
    expect(() => defineHook({ ...base, events: { UserPromptSubmit: { ...ok, hidePrompt: 'yes' as never } } })).toThrow(/hidePrompt is not a boolean/)
    expect(() => defineHook({ ...base, onInstall: 'x' as never })).toThrow('onInstall is not a function')
  })
})

describe('install with events', () => {
  const script = fakeBuild()
  let stderr = ''
  const run = async (args: string[], where: { home: string, cwd: string }, io: Partial<CliIO> & { plugin?: HookPlugin } = {}): Promise<number> => {
    stderr = ''
    const { plugin = guard(), ...rest } = io
    return createCli(plugin)(args, {
      stdin: () => '',
      script,
      node: 'v22.0.0',
      execPath: process.execPath,
      ...where,
      stdout: () => {},
      stderr: (text) => { stderr += text },
      ...rest,
    })
  }
  const read = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))
  const ours = (hook: { command: string }) => hook.command.includes('.guard/current')
  const oursIn = (file: string, event: string): unknown[] => (read(file).hooks[event] ?? []).flatMap((item: any) => item.hooks).filter(ours)
  const PINNED = /^n='.+'; \[ -x "\$n" \] \|\| n=node; "\$n" '.+\/\.guard\/current\/cli\.mjs' hook$/

  it('writes one entry per event, failing open everywhere but PreToolUse, and removes them all', async () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    expect(await run(['install', 'claude'], where)).toBe(0)
    await run(['install', 'claude'], where)
    const { hooks } = read(file)
    expect(Object.keys(hooks)).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit'])
    expect(hooks.PreToolUse[0].hooks[0].command).toMatch(/ hook \|\| exit 2$/)
    expect(hooks.PreToolUse[0].hooks[0].onFailure).toBe('block')
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: expect.stringMatching(PINNED), timeout: 10, statusMessage: 'Running guard' }] }])
    expect(hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: expect.stringMatching(PINNED), timeout: 3, statusMessage: 'Checking the prompt' }] }])
    expect(await run(['uninstall', 'claude'], where)).toBe(0)
    expect(read(file).hooks).toEqual({})
  })

  it('writes the events without a matcher or || exit 2 at project scope, for both agents', async () => {
    const where = place()
    await run(['install', 'codex', '--project'], where)
    const { hooks } = read(join(where.cwd, '.codex/hooks.json'))
    expect(hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: 'npx --no-install guard hook || exit 2', timeout: 10, statusMessage: 'Running guard' })
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'npx --no-install guard hook', timeout: 10, statusMessage: 'Running guard' }] }])
  })

  it('replaces an earlier version\'s entry at an event this one dropped or still has, and keeps other hooks there', async () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    mkdirSync(dirname(file))
    const other = { hooks: [{ type: 'command', command: 'other-stop' }] }
    const legacy = 'node \'/opt/guard-old/cli.mjs\' hook'
    writeFileSync(file, JSON.stringify({ hooks: {
      Stop: [other, { hooks: [{ type: 'command', command: `n='/old/node'; [ -x "$n" ] || n=node; "$n" '/h/.guard/current/cli.mjs' hook` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: legacy }] }],
    } }))
    const noPrompt = guard({ events: { Stop: { check: () => ({ block: false }) } }, ownCommands: [/node '\/opt\/guard-old\/cli\.mjs' hook/] })
    expect(await run(['install', 'claude'], where, { plugin: noPrompt })).toBe(0)
    const { hooks } = read(file)
    expect(hooks.Stop).toEqual([other, { hooks: [expect.objectContaining({ command: expect.stringMatching(PINNED) })] }])
    expect(hooks).not.toHaveProperty('UserPromptSubmit')
    expect(oursIn(file, 'Stop')).toHaveLength(1)
  })

  it('refuses, and changes nothing, when an event it writes to holds something other than a list', async () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    mkdirSync(dirname(file))
    const text = '{"hooks":{"Stop":{"x":1}}}'
    writeFileSync(file, text)
    expect(await run(['install', 'claude'], where)).toBe(1)
    expect(stderr).toBe(`guard: ${file} has a Stop that is not a list; it was left unchanged\n`)
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('lets a Stop or prompt entry pass, and still blocks a tool call, when the hook cannot start', async () => {
    const where = place()
    await run(['install', 'claude'], where)
    const { hooks } = read(join(where.home, '.claude/settings.json'))
    const broken = (command: string) => spawnSync('/bin/sh', ['-c', command.replace('.guard/current', '.guard/gone')], { input: '{}', env: { PATH: '/usr/bin:/bin' } }).status
    expect(broken(hooks.PreToolUse[0].hooks[0].command)).toBe(2)
    expect(broken(hooks.Stop[0].hooks[0].command)).not.toBe(2)
    expect(broken(hooks.UserPromptSubmit[0].hooks[0].command)).not.toBe(2)
  })

  it('passes a Stop or prompt payload, and blocks a tool call, on a Node.js older than 22', async () => {
    const where = place()
    for (const [input, code] of [[event('Stop', { last_assistant_message: 'x' }), 0], [event('UserPromptSubmit', { prompt: 'x' }), 0], [payload('Bash', { command: 'ls' }), 2], ['not json', 2]] as const) {
      expect(await run(['hook'], where, { stdin: () => input, node: 'v20.20.2' }), input).toBe(code)
      expect(stderr).toContain('Node.js 22 or later')
    }
  })

  it('names every event in the usage', async () => {
    await run([], place())
    expect(stderr).toContain('add the PreToolUse and Stop and UserPromptSubmit hooks')
  })
})

describe('install steps', () => {
  const script = fakeBuild()
  const cli = (plugin: HookPlugin, args: string[], where: { home: string, cwd: string }) => {
    const out = { stdout: '', stderr: '' }
    const done = createCli(plugin)(args, {
      stdin: () => '',
      script,
      node: 'v22.0.0',
      execPath: process.execPath,
      ...where,
      stdout: (text) => { out.stdout += text },
      stderr: (text) => { out.stderr += text },
    })
    return done.then(code => ({ code, ...out }))
  }

  it('run after the config is written, with where it went, and print their notes and warnings', async () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    const seen: InstallPlace[] = []
    const plugin = guard({
      onInstall: (at) => {
        seen.push(at)
        expect(existsSync(at.file)).toBe(true)
        return { notes: ['Installed the skill in /s'], warnings: ['left /t as it is'] }
      },
      onUninstall: (at) => {
        seen.push(at)
        return { notes: ['Removed the skill'] }
      },
    })
    expect(await cli(plugin, ['install', 'claude'], where)).toEqual({ code: 0, stdout: `Installed in ${file}\nInstalled the skill in /s\n`, stderr: 'guard: left /t as it is\n' })
    expect(await cli(plugin, ['uninstall', 'claude', '--project'], where)).toEqual({ code: 0, stdout: `Removed from ${join(where.cwd, '.claude/settings.json')}\nRemoved the skill\n`, stderr: '' })
    expect(seen).toEqual([
      { agent: 'claude', scope: 'user', home: where.home, cwd: where.cwd, script, file },
      { agent: 'claude', scope: 'project', home: where.home, cwd: where.cwd, script, file: join(where.cwd, '.claude/settings.json') },
    ])
    expect(existsSync(join(where.cwd, '.claude'))).toBe(false)
  })

  it('put the config back as it was when they throw or return something else', async () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    const failing = guard({ onInstall: () => {
      throw new Error('no skill source')
    } })
    expect(await cli(failing, ['install', 'claude'], where)).toEqual({ code: 1, stdout: '', stderr: 'guard: no skill source\n' })
    expect(existsSync(file)).toBe(false)
    await cli(guard(), ['install', 'claude'], where)
    const installed = readFileSync(file, 'utf8')
    for (const plugin of [guard({ onUninstall: () => {
      throw new Error('busy')
    } }), guard({ onUninstall: () => ({ notes: 'x' }) as never }), guard({ onUninstall: () => 'done' as never })]) {
      expect((await cli(plugin, ['uninstall', 'claude'], where)).code).toBe(1)
      expect(readFileSync(file, 'utf8')).toBe(installed)
    }
    expect(await cli(guard({ onInstall: () => ({ warnings: [1] }) as never }), ['install', 'codex'], where)).toEqual({ code: 1, stdout: '', stderr: 'guard: warnings is not a list of strings\n' })
    expect(existsSync(join(where.home, '.codex/hooks.json'))).toBe(false)
  })
})

describe('claudePluginFiles with events', () => {
  it('writes each event beside PreToolUse, failing open', () => {
    const { hooks } = JSON.parse(claudePluginFiles({ plugin: guard(), entry: 'dist/cli.mjs' })['hooks/hooks.json']!)
    expect(Object.keys(hooks)).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit'])
    expect(hooks.PreToolUse[0].hooks[0]).toMatchObject({ command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook || exit 2', onFailure: 'block' })
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook', timeout: 10, statusMessage: 'Running guard' }] }])
    expect(hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook', timeout: 3, statusMessage: 'Checking the prompt' }] }])
  })
})
