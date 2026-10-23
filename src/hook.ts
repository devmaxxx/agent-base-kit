import type { HookPlugin, HookVerdict, ToolCall } from './types'
import process from 'node:process'
import { KIND_OF_TOOL } from './agents'

/** Where {@link runHook} falls back to and writes to; both default to the process. */
export interface RunHookOptions {
  /** The working directory a payload without `cwd` gets. */
  cwd?: string
  /** Receives the block reason or the error, newline-terminated. */
  stderr?: (text: string) => void
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// An absent field is empty, but one of another shape (a `command` sent as an
// array) would check as empty and let through whatever the tool makes of it.
function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (value === undefined || value === null)
    return ''
  if (typeof value !== 'string')
    throw new TypeError(`${key} is not a string`)
  return value
}

// The same holds one level up: a `tool_input` sent as a string, or `edits` as
// one object instead of a list, would read as nothing to check.
function record(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined || value === null)
    return {}
  if (!isObject(value))
    throw new TypeError(`${key} is not an object`)
  return value
}

function editList(input: Record<string, unknown>): Record<string, unknown>[] {
  const edits = input.edits ?? []
  if (!Array.isArray(edits))
    throw new TypeError('edits is not a list')
  return edits.map(edit => record(edit, 'edit'))
}

// Claude Code and Codex share the hook protocol; they differ in tool names and
// in Codex's apply_patch, which carries a whole patch instead of one file.
function toToolCall(tool: string, input: Record<string, unknown>): ToolCall {
  const text = (key: string, from = input): string => stringField(from, key)
  const joined = (key: string): string => editList(input).map(edit => text(key, edit)).join('\n')
  switch (tool) {
    case 'Bash':
      return { kind: 'shell', command: text('command') }
    case 'Write':
      return { kind: 'write', path: text('file_path'), content: text('content') }
    case 'NotebookEdit':
      return { kind: 'write', path: text('notebook_path'), content: text('new_source') }
    case 'Edit':
      return { kind: 'edit', path: text('file_path'), before: text('old_string'), after: text('new_string') }
    case 'MultiEdit':
      return { kind: 'edit', path: text('file_path'), before: joined('old_string'), after: joined('new_string') }
    case 'apply_patch':
      return { kind: 'patch', patch: text('command') || text('input') || text('patch') }
    default:
      throw new TypeError(`${tool} is not a tool the hook reads`)
  }
}

// A check written as `return` on one path and nothing on another, or one that
// returns a truthy string, must not read as a pass.
function verdictOf(value: unknown): HookVerdict {
  if (isObject(value) && value.block === false)
    return { block: false }
  if (isObject(value) && value.block === true && typeof value.reason === 'string' && value.reason.trim() !== '')
    return { block: true, reason: value.reason }
  throw new TypeError('check returned neither { block: false } nor { block: true, reason }')
}

/**
 * Runs one PreToolUse call through the plugin and returns the exit code the
 * agent reads: 2 blocks the call, 0 lets it run.
 *
 * It fails closed. A payload that is not JSON, a field of the wrong shape, a
 * check that throws or rejects, and a result that is not a verdict all return
 * 2 with the error on stderr, because any other exit lets the call run
 * unchecked. A tool the plugin did not ask for returns 0 without calling the
 * check; so does a payload that names no tool.
 */
export async function runHook(plugin: HookPlugin, stdin: string, options: RunHookOptions = {}): Promise<number> {
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text))
  let verdict: HookVerdict
  try {
    const payload: unknown = JSON.parse(stdin)
    if (!isObject(payload))
      throw new TypeError('payload is not an object')
    const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    const kind = KIND_OF_TOOL.get(tool)
    if (kind === undefined || !plugin.kinds.includes(kind))
      return 0
    const call = toToolCall(tool, record(payload.tool_input, 'tool_input'))
    const cwd = stringField(payload, 'cwd') || (options.cwd ?? process.cwd())
    verdict = verdictOf(await plugin.check(call, { cwd }))
  }
  catch (error) {
    stderr(`Blocked by ${plugin.name}, it could not check the call: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (!verdict.block)
    return 0
  stderr(verdict.reason.endsWith('\n') ? verdict.reason : `${verdict.reason}\n`)
  return 2
}
