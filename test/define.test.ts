import type { HookDefinition, ToolKind } from '../src'
import { describe, expect, it } from 'vitest'
import { defineHook, matcherFor } from '../src'

describe('defineHook', () => {
  const valid: HookDefinition<ToolKind> = { name: 'my-guard', kinds: ['shell'], check: () => ({ block: false }) }

  it('fills in the package name, status message and timeout', () => {
    expect(defineHook(valid)).toMatchObject({ name: 'my-guard', packageName: 'my-guard', statusMessage: 'Running my-guard', timeout: 10 })
    expect(defineHook({ ...valid, packageName: '@acme/my-guard', statusMessage: 'Guarding', timeout: 5 })).toMatchObject({ packageName: '@acme/my-guard', statusMessage: 'Guarding', timeout: 5 })
  })

  it('refuses a name that is not kebab-case, since it becomes a directory and a plugin name', () => {
    for (const name of ['', 'My-Guard', 'my guard', '-guard', 'guard-', 'my--guard', '../guard', 'a/b', '.guard'])
      expect(() => defineHook({ ...valid, name }), name).toThrow(/^name /)
  })

  it('refuses a package name the shell would read as more than a name', () => {
    for (const packageName of ['-guard', 'my guard', 'guard;rm', '$(id)', 'Guard', '@acme', '~guard'])
      expect(() => defineHook({ ...valid, packageName }), packageName).toThrow(/^packageName /)
  })

  it('refuses kinds that are empty or unknown, a missing check, and a timeout that is not whole seconds', () => {
    expect(() => defineHook({ ...valid, kinds: [] })).toThrow(/^kinds /)
    expect(() => defineHook({ ...valid, kinds: ['read' as ToolKind] })).toThrow(/^kinds /)
    expect(() => defineHook({ ...valid, check: undefined as never })).toThrow(/^check /)
    for (const timeout of [0, -1, 1.5, Number.NaN])
      expect(() => defineHook({ ...valid, timeout }), String(timeout)).toThrow(/^timeout /)
  })
})

describe('matcherFor', () => {
  it('routes each kind to the Claude Code tools that make it', () => {
    expect(matcherFor('claude', ['shell', 'write', 'edit', 'patch'])).toBe('Bash|Write|Edit|MultiEdit|NotebookEdit')
    expect(matcherFor('claude', ['shell'])).toBe('Bash')
    expect(matcherFor('claude', ['write'])).toBe('Write|NotebookEdit')
    expect(matcherFor('claude', ['edit'])).toBe('Edit|MultiEdit')
    expect(matcherFor('claude', ['patch'])).toBe('')
  })

  it('routes every file change to apply_patch in Codex', () => {
    expect(matcherFor('codex', ['shell', 'write', 'edit', 'patch'])).toBe('Bash|apply_patch')
    expect(matcherFor('codex', ['shell'])).toBe('Bash')
    for (const kind of ['write', 'edit', 'patch'] as const)
      expect(matcherFor('codex', [kind]), kind).toBe('apply_patch')
  })
})
