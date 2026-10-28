import type { EventDefinition, EventHook, HookDefinition, HookPlugin, ToolKind } from './types'
import { KIND_OF_TOOL } from './agents'

const KINDS: readonly ToolKind[] = ['shell', 'write', 'edit', 'patch', 'tool']

// A tool name lands in the agents' matcher, which they read as a regular
// expression, so it holds nothing a pattern would read as syntax.
const TOOL_NAME = /^[\w-]+$/

const EVENTS = ['Stop', 'UserPromptSubmit'] as const

// The name becomes a directory under the home directory and a Claude Code
// plugin name, so it allows nothing that could leave either.
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// The package name lands unquoted in a shell command. npm's own rules already
// keep out whitespace and quotes; a leading `-` would read as an npx flag.
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Checks a hook definition and returns the plugin every other function takes.
 * Throws a `TypeError` naming the field when the definition is malformed, so a
 * broken plugin fails when it is built, not when the hook runs.
 */
export function defineHook<const K extends ToolKind>(definition: HookDefinition<K>): HookPlugin {
  const { name, kinds, check, packageName = name, statusMessage = `Running ${name}`, timeout = 10, ownCommands = [], tools = [], events = {}, onInstall, onUninstall } = definition
  if (typeof name !== 'string' || !NAME.test(name))
    throw new TypeError(`name ${JSON.stringify(name)} is not kebab-case (lowercase letters and digits, joined by single hyphens)`)
  if (typeof packageName !== 'string' || !PACKAGE.test(packageName))
    throw new TypeError(`packageName ${JSON.stringify(packageName)} is not an npm package name`)
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some(kind => !KINDS.includes(kind)))
    throw new TypeError(`kinds must list one or more of ${KINDS.join(', ')}`)
  if (typeof check !== 'function')
    throw new TypeError('check is not a function')
  checkStatus(statusMessage, 'statusMessage')
  checkTimeout(timeout, 'timeout')
  // Copied before the check: `some` skips the holes of a sparse list, and the
  // copy turns each into `undefined`. A global or sticky pattern keeps its
  // place between tests, so the same command would alternate between matching
  // and not; a multiline one would match a single line of the command.
  const patterns: unknown[] | null = Array.isArray(ownCommands) ? [...ownCommands] : null
  if (patterns === null || patterns.some(pattern => !(pattern instanceof RegExp) || pattern.global || pattern.multiline || pattern.sticky))
    throw new TypeError('ownCommands must list regular expressions without the g, m or y flag')
  const names: unknown[] | null = Array.isArray(tools) ? [...tools] : null
  if (names === null || names.some(tool => typeof tool !== 'string' || !TOOL_NAME.test(tool)))
    throw new TypeError('tools must list tool names of letters, digits, _ and -')
  const builtIn = (names as string[]).find(tool => KIND_OF_TOOL.has(tool))
  if (builtIn !== undefined)
    throw new TypeError(`${builtIn} is one of the agents' own tools; list its kind instead`)
  if (kinds.includes('tool' as K) !== (names.length > 0))
    throw new TypeError('kinds lists tool exactly when tools names one or more tools')
  for (const [key, hook] of [['onInstall', onInstall], ['onUninstall', onUninstall]] as const) {
    if (hook !== undefined && typeof hook !== 'function')
      throw new TypeError(`${key} is not a function`)
  }
  return Object.freeze({
    name,
    packageName,
    kinds: Object.freeze([...new Set<ToolKind>(kinds)]),
    statusMessage,
    timeout,
    ownCommands: Object.freeze(patterns as RegExp[]),
    tools: Object.freeze([...new Set(names as string[])]),
    events: eventHooks(events, statusMessage, timeout),
    onInstall,
    onUninstall,
    // runHook hands the check only the kinds it listed, which is what makes
    // the narrower parameter safe to widen.
    check: check as HookPlugin['check'],
  })
}

function checkStatus(value: unknown, field: string): void {
  if (typeof value !== 'string' || value === '')
    throw new TypeError(`${field} is not a non-empty string`)
}

function checkTimeout(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new TypeError(`${field} ${JSON.stringify(value)} is not a whole number of seconds`)
}

function eventHook<I>(event: string, definition: EventDefinition<I>, statusMessage: string, timeout: number): EventHook<I> {
  if (typeof definition !== 'object' || definition === null || typeof definition.check !== 'function')
    throw new TypeError(`events.${event}.check is not a function`)
  const hook = { check: definition.check, statusMessage: definition.statusMessage ?? statusMessage, timeout: definition.timeout ?? timeout }
  checkStatus(hook.statusMessage, `events.${event}.statusMessage`)
  checkTimeout(hook.timeout, `events.${event}.timeout`)
  return hook
}

// An event the kit does not run, such as a misspelt one, would install
// nothing and never say so.
function eventHooks(events: HookDefinition<ToolKind>['events'], statusMessage: string, timeout: number): HookPlugin['events'] {
  if (typeof events !== 'object' || events === null || Array.isArray(events))
    throw new TypeError('events is not an object')
  const unknown = Object.keys(events).find(event => !(EVENTS as readonly string[]).includes(event))
  if (unknown !== undefined)
    throw new TypeError(`events.${unknown} is not one of ${EVENTS.join(', ')}`)
  const { Stop, UserPromptSubmit } = events
  const hidePrompt = UserPromptSubmit?.hidePrompt ?? false
  if (typeof hidePrompt !== 'boolean')
    throw new TypeError('events.UserPromptSubmit.hidePrompt is not a boolean')
  return Object.freeze({
    ...(Stop ? { Stop: Object.freeze(eventHook('Stop', Stop, statusMessage, timeout)) } : {}),
    ...(UserPromptSubmit ? { UserPromptSubmit: Object.freeze({ ...eventHook('UserPromptSubmit', UserPromptSubmit, statusMessage, timeout), hidePrompt }) } : {}),
  })
}
