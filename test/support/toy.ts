import type { HookPlugin, ToolCall, ToolKind } from '../../src'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHook } from '../../src'

function textOf(call: ToolCall): string {
  switch (call.kind) {
    case 'shell':
      return call.command
    case 'write':
      return call.content
    case 'edit':
      return call.after
    case 'patch':
      return call.patch
  }
}

/** Blocks any call whose text holds FORBIDDEN. */
export function toyGuard(kinds: readonly ToolKind[] = ['shell', 'write', 'edit', 'patch'], name = 'toy-guard'): HookPlugin {
  return defineHook({
    name,
    kinds,
    check: call => textOf(call).includes('FORBIDDEN') ? { block: true, reason: `${name}: FORBIDDEN is not allowed` } : { block: false },
  })
}

export function payload(tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra })
}

/** A fresh home and project directory under the system temp dir. */
export function place(): { home: string, cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'at-'))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(home)
  mkdirSync(cwd)
  return { home, cwd }
}

/** A build directory shaped like tsdown's output, whose entry runs as a no-op. */
export function fakeBuild(body = 'cli'): string {
  const dir = mkdtempSync(join(tmpdir(), 'at-build-'))
  writeFileSync(join(dir, 'cli.mjs'), `import './chunk.mjs' // ${body}`)
  writeFileSync(join(dir, 'chunk.mjs'), '')
  writeFileSync(join(dir, 'cli.d.mts'), '')
  return join(dir, 'cli.mjs')
}
