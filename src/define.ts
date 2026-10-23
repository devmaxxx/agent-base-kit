import type { HookDefinition, HookPlugin, ToolKind } from './types'

const KINDS: readonly ToolKind[] = ['shell', 'write', 'edit', 'patch']

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
  const { name, kinds, check, packageName = name, statusMessage = `Running ${name}`, timeout = 10 } = definition
  if (typeof name !== 'string' || !NAME.test(name))
    throw new TypeError(`name ${JSON.stringify(name)} is not kebab-case (lowercase letters and digits, joined by single hyphens)`)
  if (typeof packageName !== 'string' || !PACKAGE.test(packageName))
    throw new TypeError(`packageName ${JSON.stringify(packageName)} is not an npm package name`)
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some(kind => !KINDS.includes(kind)))
    throw new TypeError(`kinds must list one or more of ${KINDS.join(', ')}`)
  if (typeof check !== 'function')
    throw new TypeError('check is not a function')
  if (typeof statusMessage !== 'string' || statusMessage === '')
    throw new TypeError('statusMessage is not a non-empty string')
  if (!Number.isInteger(timeout) || timeout < 1)
    throw new TypeError(`timeout ${JSON.stringify(timeout)} is not a whole number of seconds`)
  return Object.freeze({
    name,
    packageName,
    kinds: Object.freeze([...new Set<ToolKind>(kinds)]),
    statusMessage,
    timeout,
    // runHook hands the check only the kinds it listed, which is what makes
    // the narrower parameter safe to widen.
    check: check as HookPlugin['check'],
  })
}
