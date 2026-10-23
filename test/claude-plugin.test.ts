import type { ClaudePluginOptions } from '../src'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudePluginFiles, defineHook, writeClaudePlugin } from '../src'
import { toyGuard } from './support/toy'

describe('claudePluginFiles', () => {
  const options: ClaudePluginOptions = {
    plugin: toyGuard(),
    entry: 'dist/cli.mjs',
    version: '1.2.3',
    description: 'Blocks FORBIDDEN',
    author: { name: 'devmaxxx' },
    homepage: 'https://example.com/toy-guard',
    license: 'MIT',
  }
  const read = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))
  const hookOf = (opts: ClaudePluginOptions) => JSON.parse(claudePluginFiles(opts)['hooks/hooks.json']!).hooks.PreToolUse[0]

  it('writes the manifest and the hooks file at the paths Claude Code loads them from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'at-plugin-'))
    expect(writeClaudePlugin(dir, options)).toEqual([join(dir, '.claude-plugin/plugin.json'), join(dir, 'hooks/hooks.json')])
    expect(read(join(dir, '.claude-plugin/plugin.json'))).toEqual({
      name: 'toy-guard',
      version: '1.2.3',
      description: 'Blocks FORBIDDEN',
      author: { name: 'devmaxxx' },
      homepage: 'https://example.com/toy-guard',
      license: 'MIT',
    })
    expect(read(join(dir, 'hooks/hooks.json'))).toEqual({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook || exit 2', timeout: 10, statusMessage: 'Running toy-guard', onFailure: 'block' }],
        }],
      },
    })
    expect(existsSync(join(dir, '.claude-plugin/marketplace.json'))).toBe(false)
  })

  it('runs the bin under the plugin root, and blocks when it cannot start', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'at-plugin-')), `my plugin's root`)
    const { command } = hookOf({ ...options, entry: './dist/cli.mjs' }).hooks[0]
    // Claude Code substitutes the variable into the command and also exports it.
    const sh = () => spawnSync('/bin/sh', ['-c', command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)], { input: '{}', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } })
    expect(sh().status).toBe(2)
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist/cli.mjs'), 'process.stdout.write(process.argv.slice(2).join(\' \'))\n')
    const ran = sh()
    expect(ran.status).toBe(0)
    expect(ran.stdout.toString()).toBe('hook')
  })

  it('routes only the tools the kinds call for', () => {
    expect(hookOf({ ...options, plugin: toyGuard(['shell']) }).matcher).toBe('Bash')
    expect(hookOf({ ...options, plugin: toyGuard(['write', 'patch']) }).matcher).toBe('Write|NotebookEdit')
  })

  it('writes a marketplace that installs the plugin from its npm package', () => {
    const plugin = defineHook({ name: 'toy-guard', packageName: '@acme/toy-guard', kinds: ['shell'], check: () => ({ block: false }) })
    const files = claudePluginFiles({ ...options, plugin, marketplace: { name: 'acme', owner: { name: 'Acme' }, version: '^1.2.0' } })
    expect(JSON.parse(files['.claude-plugin/marketplace.json']!)).toEqual({
      name: 'acme',
      owner: { name: 'Acme' },
      description: 'Blocks FORBIDDEN',
      plugins: [{ name: 'toy-guard', source: { source: 'npm', package: '@acme/toy-guard', version: '^1.2.0' }, description: 'Blocks FORBIDDEN' }],
    })
  })

  it('refuses what would make Claude Code skip or reject the plugin', () => {
    expect(() => claudePluginFiles({ ...options, plugin: toyGuard(['patch']) })).toThrow('which Claude Code does not make')
    for (const entry of ['../cli.mjs', 'dist/../../cli.mjs', '/abs/cli.mjs', 'dist/cli.ts', 'dist/$(id).mjs', 'dist/"x".mjs', 'dist\\cli.mjs'])
      expect(() => claudePluginFiles({ ...options, entry }), entry).toThrow(/^entry /)
    expect(() => claudePluginFiles({ ...options, homepage: 'example.com' })).toThrow(/^homepage /)
    expect(() => claudePluginFiles({ ...options, plugin: toyGuard(undefined, 'claude-guard') })).toThrow('reserves')
    expect(() => claudePluginFiles({ ...options, marketplace: { name: 'my market', owner: { name: 'x' } } })).toThrow(/^marketplace name /)
  })
})
