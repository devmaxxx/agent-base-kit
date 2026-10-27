import type { HookPlugin, HookVerdict, ToolCall } from './types'
import process from 'node:process'
import { KIND_OF_TOOL } from './agents'

/** Where {@link runHook} falls back to and writes to; both default to the process. */
export interface RunHookOptions {
  /** The working directory a payload without `cwd` gets. */
  cwd?: string
  /** Receives the block reason or the error, newline-terminated. */
  stderr?: (text: string) => void
  /** Receives the decision a Stop or UserPromptSubmit check blocks with, as a JSON line. */
  stdout?: (text: string) => void
}

// The events whose hook lets the agent go on when it cannot decide: an exit 2
// at Stop keeps the agent going, so a broken hook would loop it, and one at
// UserPromptSubmit would drop every prompt the user sends.
const OPEN_EVENTS = ['Stop', 'UserPromptSubmit'] as const
type OpenEvent = typeof OPEN_EVENTS[number]

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
function toToolCall(plugin: HookPlugin, tool: string, input: Record<string, unknown>): ToolCall {
  if (plugin.tools.includes(tool))
    return { kind: 'tool', name: tool, input }
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

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The event a hook payload is for when it names one the hook lets pass on a
 * fault, else `undefined`. Read before the Node.js check and the hang guard,
 * which must not block these either.
 */
export function openEventOf(stdin: string): OpenEvent | undefined {
  try {
    const event: unknown = JSON.parse(stdin)?.hook_event_name
    return OPEN_EVENTS.find(open => open === event)
  }
  catch {
    return undefined
  }
}

async function runOpenEvent(plugin: HookPlugin, event: OpenEvent, payload: Record<string, unknown>, options: RunHookOptions): Promise<number> {
  const hook = plugin.events[event]
  if (!hook)
    return 0
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text))
  const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text))
  try {
    // A Stop hook that blocks again on the reply its own block produced would
    // keep the agent going forever.
    if (event === 'Stop' && payload.stop_hook_active === true)
      return 0
    const cwd = stringField(payload, 'cwd') || (options.cwd ?? process.cwd())
    const verdict = event === 'Stop'
      ? verdictOf(await plugin.events.Stop!.check({ reply: stringField(payload, 'last_assistant_message') }, { cwd }))
      : verdictOf(await plugin.events.UserPromptSubmit!.check({ prompt: stringField(payload, 'prompt') }, { cwd }))
    if (!verdict.block)
      return 0
    const hidden = event === 'UserPromptSubmit' && plugin.events.UserPromptSubmit!.hidePrompt
    stdout(`${JSON.stringify({
      decision: 'block',
      reason: verdict.reason,
      ...(hidden ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } } : {}),
    })}\n`)
  }
  catch (error) {
    stderr(`${plugin.name} could not check the ${event === 'Stop' ? 'reply' : 'prompt'}, so it let it pass: ${messageOf(error)}\n`)
  }
  return 0
}

/**
 * Runs one hook payload through the plugin and returns the exit code the
 * agent reads.
 *
 * A PreToolUse call returns 2 to block it and 0 to let it run, and fails
 * closed: a payload that is not JSON or names no tool, a field of the wrong
 * shape, a check that throws or rejects, and a result that is not a verdict
 * all return 2 with the error on stderr, because any other exit lets the call
 * run unchecked. A tool the plugin did not ask for returns 0 without calling
 * the check. A payload with no `hook_event_name` is read as PreToolUse.
 *
 * Stop and UserPromptSubmit always return 0. A block goes to stdout as
 * `{"decision":"block","reason":…}`, and a fault to stderr, letting the event
 * pass. A Stop with `stop_hook_active` set passes unchecked, and so does an
 * event the plugin has no check for.
 */
export async function runHook(plugin: HookPlugin, stdin: string, options: RunHookOptions = {}): Promise<number> {
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text))
  let verdict: HookVerdict
  try {
    const payload: unknown = JSON.parse(stdin)
    if (!isObject(payload))
      throw new TypeError('payload is not an object')
    const event = payload.hook_event_name
    const open = OPEN_EVENTS.find(name => name === event)
    if (open)
      return runOpenEvent(plugin, open, payload, options)
    // An event the plugin never installed for, such as PostToolUse, has
    // nothing to block.
    if (typeof event === 'string' && event !== 'PreToolUse')
      return 0
    // Both agents always name the tool, so a payload without one is a shape
    // this does not know, and reading it as some other tool would let it run.
    const tool = payload.tool_name
    if (typeof tool !== 'string' || tool === '')
      throw new TypeError('tool_name is not a tool name')
    const kind = plugin.tools.includes(tool) ? 'tool' : KIND_OF_TOOL.get(tool)
    if (kind === undefined || !plugin.kinds.includes(kind))
      return 0
    const call = toToolCall(plugin, tool, record(payload.tool_input, 'tool_input'))
    const cwd = stringField(payload, 'cwd') || (options.cwd ?? process.cwd())
    verdict = verdictOf(await plugin.check(call, { cwd }))
  }
  catch (error) {
    stderr(`Blocked by ${plugin.name}, it could not check the call: ${messageOf(error)}\n`)
    return 2
  }
  if (!verdict.block)
    return 0
  stderr(verdict.reason.endsWith('\n') ? verdict.reason : `${verdict.reason}\n`)
  return 2
}
