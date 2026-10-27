import type { HookVerdict, ToolCall, ToolKind } from '../src'
import { describe, expect, it } from 'vitest'
import { defineHook, runHook } from '../src'
import { payload, toyGuard } from './support/toy'

describe('runHook', () => {
  const run = async (input: string, plugin = toyGuard()): Promise<{ code: number, stderr: string }> => {
    let stderr = ''
    const code = await runHook(plugin, input, { cwd: '/fallback', stderr: (text) => {
      stderr += text
    } })
    return { code, stderr }
  }
  const recording = (kinds: readonly ToolKind[] = ['shell', 'write', 'edit', 'patch']) => {
    const seen: { call: ToolCall, cwd: string }[] = []
    const plugin = defineHook({ name: 'recorder', kinds, check: (call, { cwd }) => {
      seen.push({ call, cwd })
      return { block: false }
    } })
    return { plugin, seen }
  }

  it('blocks a call the check rejects with exit 2 and prints its reason', async () => {
    expect(await run(payload('Bash', { command: 'echo FORBIDDEN' }))).toEqual({ code: 2, stderr: 'toy-guard: FORBIDDEN is not allowed\n' })
  })

  it('lets a call the check passes run, silently', async () => {
    expect(await run(payload('Bash', { command: 'ls' }))).toEqual({ code: 0, stderr: '' })
  })

  it('hands the check each tool of either agent as its kind of call', async () => {
    const { plugin, seen } = recording()
    const inputs: [string, unknown][] = [
      ['Bash', { command: 'ls -la' }],
      ['Write', { file_path: '/p/a.js', content: 'x' }],
      ['NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: 'cell' }],
      ['Edit', { file_path: '/p/a.js', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: '/p/a.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }],
      ['apply_patch', { command: '*** Begin Patch' }],
      ['apply_patch', { input: '*** Begin Patch' }],
      ['apply_patch', { patch: '*** Begin Patch' }],
    ]
    for (const [tool, input] of inputs)
      expect(await run(payload(tool, input), plugin), tool).toEqual({ code: 0, stderr: '' })
    expect(seen.map(({ call }) => call)).toEqual([
      { kind: 'shell', command: 'ls -la' },
      { kind: 'write', path: '/p/a.js', content: 'x' },
      { kind: 'write', path: '/p/n.ipynb', content: 'cell' },
      { kind: 'edit', path: '/p/a.js', before: 'a', after: 'b' },
      { kind: 'edit', path: '/p/a.js', before: 'a', after: 'b' },
      { kind: 'edit', path: '/p/a.js', before: 'c', after: 'd' },
      { kind: 'patch', patch: '*** Begin Patch' },
      { kind: 'patch', patch: '*** Begin Patch' },
      { kind: 'patch', patch: '*** Begin Patch' },
    ])
  })

  it('checks each edit of a MultiEdit on its own, so another edit\'s old_string cannot vouch for what one adds', async () => {
    const plugin = defineHook({
      name: 'adds-nothing',
      kinds: ['edit'],
      check: call => call.after.includes('TOKEN') && !call.before.includes('TOKEN') ? { block: true, reason: 'adds TOKEN' } : { block: false },
    })
    const edits = [{ old_string: 'a', new_string: 'TOKEN' }, { old_string: 'TOKEN b', new_string: 'TOKEN c' }]
    expect(await run(payload('MultiEdit', { file_path: 'a.js', edits }), plugin)).toEqual({ code: 2, stderr: 'adds TOKEN\n' })
    expect(await run(payload('MultiEdit', { file_path: 'a.js', edits: edits.slice(1) }), plugin)).toEqual({ code: 0, stderr: '' })
  })

  it('reads an absent field or tool input as empty', async () => {
    const { plugin, seen } = recording()
    await run(payload('Bash', null), plugin)
    await run(payload('MultiEdit', { file_path: 'a.js' }), plugin)
    expect(seen.map(({ call }) => call)).toEqual([
      { kind: 'shell', command: '' },
      { kind: 'edit', path: 'a.js', before: '', after: '' },
    ])
  })

  it('gives the check the payload\'s working directory, else the fallback', async () => {
    const { plugin, seen } = recording()
    await run(payload('Bash', { command: 'ls' }, { cwd: '/work' }), plugin)
    await run(payload('Bash', { command: 'ls' }), plugin)
    expect(seen.map(({ cwd }) => cwd)).toEqual(['/work', '/fallback'])
  })

  it('blocks a payload it cannot read instead of letting the call run', async () => {
    const unnamed = ['{}', '{"tool_name":""}', '{"tool_name":7}', '{"toolName":"Bash"}', JSON.stringify({ tool_input: { command: 'FORBIDDEN' } })]
    for (const input of ['', '{"tool_name":', 'null', '[]', '"Bash"', ...unnamed]) {
      const { code, stderr } = await run(input)
      expect(code, input).toBe(2)
      expect(stderr, input).toMatch(/^Blocked by toy-guard, it could not check the call: /)
    }
  })

  it('blocks a field, tool input or edit list of the wrong shape instead of reading it as empty', async () => {
    const wrong = [
      payload('Bash', { command: ['echo', 'FORBIDDEN'] }),
      payload('Write', { file_path: 'a.js', content: { text: 'FORBIDDEN' } }),
      payload('Bash', 'echo FORBIDDEN'),
      payload('MultiEdit', { file_path: 'a.js', edits: { new_string: 'FORBIDDEN' } }),
      payload('MultiEdit', { file_path: 'a.js', edits: ['FORBIDDEN'] }),
      payload('Bash', { command: 'ls' }, { cwd: 7 }),
    ]
    for (const input of wrong)
      expect((await run(input)).code, input).toBe(2)
  })

  it('blocks when the check throws, rejects, or returns anything but a verdict', async () => {
    const results: unknown[] = [undefined, null, 'ok', { block: 'no' }, { block: true }, { block: true, reason: ' ' }]
    const checks: (() => HookVerdict | Promise<HookVerdict>)[] = [
      () => { throw new Error('boom') },
      () => Promise.reject(new Error('boom')),
      ...results.map(result => () => result as HookVerdict),
    ]
    for (const check of checks) {
      const { code, stderr } = await run(payload('Bash', { command: 'ls' }), defineHook({ name: 'broken', kinds: ['shell'], check }))
      expect(code).toBe(2)
      expect(stderr).toMatch(/^Blocked by broken, it could not check the call: /)
    }
  })

  it('waits for a check that answers asynchronously', async () => {
    const later = defineHook({ name: 'later', kinds: ['shell'], check: async call => ({ block: call.command === 'rm', reason: 'later: no rm' }) as HookVerdict })
    expect(await run(payload('Bash', { command: 'rm' }), later)).toEqual({ code: 2, stderr: 'later: no rm\n' })
    expect((await run(payload('Bash', { command: 'ls' }), later)).code).toBe(0)
  })

  it('never hands the check a tool or kind it did not ask for', async () => {
    const { plugin, seen } = recording(['shell'])
    const others = [
      payload('Write', { file_path: 'a.js', content: 'FORBIDDEN' }),
      payload('apply_patch', { command: 'FORBIDDEN' }),
      payload('Read', { file_path: 'a.js' }),
      payload('constructor', {}),
    ]
    for (const input of others)
      expect(await run(input, plugin), input).toEqual({ code: 0, stderr: '' })
    expect(seen).toEqual([])
  })
})
