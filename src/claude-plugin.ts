import type { HookPlugin } from './types'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { requireMatcher } from './agents'

/** A person or organisation, as the plugin and marketplace manifests take it. */
export interface ClaudePluginPerson {
  name: string
  email?: string
  url?: string
}

/** The plugin package's metadata; the hook itself comes from `plugin`. */
export interface ClaudePluginOptions {
  plugin: HookPlugin
  /** The built bin, relative to the package root: `dist/cli.mjs`. */
  entry: string
  /** The package version. Without it, Claude Code lists a plugin installed from npm as version `unknown`. */
  version?: string
  description?: string
  author?: ClaudePluginPerson
  /** Must be a URL; Claude Code does not load a plugin whose homepage is not one. */
  homepage?: string
  repository?: string
  license?: string
  keywords?: readonly string[]
  /**
   * Also writes `.claude-plugin/marketplace.json`: a marketplace of this one
   * plugin, fetched from npm as `packageName`, at `version` (a version or
   * range) or the latest one.
   */
  marketplace?: { name: string, owner: ClaudePluginPerson, version?: string }
}

const MARKETPLACE_NAME = /^[a-z0-9][\w.-]*$/i

// The names `claude plugin validate` rejects as passing for Anthropic's own,
// as of Claude Code 2.1.309.
const RESERVED = /^(?:claude|anthropics?)(?:-|$)|^cc-plugin-|(?:claude|anthropic)s?-?official|official-?(?:claude|anthropic)/

// The entry lands inside double quotes in a shell command, so it may hold
// nothing the shell expands there. No segment starts with a dot, so it stays
// inside the plugin root, the only directory Claude Code copies.
const ENTRY = /^[\w-][\w.-]*(?:\/[\w-][\w.-]*)*\.mjs$/

// Claude Code puts the plugin's path in for the variable before the shell
// runs, and its docs ask for double quotes around it.
function pluginHooks(plugin: HookPlugin, matcher: string, entry: string): Record<string, unknown[]> {
  const command = `node "\${CLAUDE_PLUGIN_ROOT}/${entry}" hook`
  const hooks: Record<string, unknown[]> = {
    PreToolUse: [{
      matcher,
      hooks: [{ type: 'command', command: `${command} || exit 2`, timeout: plugin.timeout, statusMessage: plugin.statusMessage, onFailure: 'block' }],
    }],
  }
  for (const [event, hook] of Object.entries(plugin.events))
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout: hook.timeout, statusMessage: hook.statusMessage }] }]
  return hooks
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

function entryOf(entry: string): string {
  const relative = entry.replace(/^\.\//, '')
  if (!ENTRY.test(relative))
    throw new TypeError(`entry ${JSON.stringify(entry)} is not a .mjs path inside the package`)
  return relative
}

/**
 * The files that make a plugin package a Claude Code plugin, by path relative
 * to the package root: `.claude-plugin/plugin.json`, `hooks/hooks.json`, and
 * with `marketplace`, `.claude-plugin/marketplace.json`.
 *
 * The PreToolUse hook runs `node "${CLAUDE_PLUGIN_ROOT}/<entry>" hook || exit 2`
 * with `onFailure: "block"`, so a plugin that cannot start or times out blocks
 * the call; each of the plugin's other events runs the same command without
 * either, so it passes instead. Claude Code copies the plugin and installs
 * nothing into it, and the plugin's `onInstall` does not run, so the entry's
 * directory must hold the whole build. Throws when the plugin checks
 * no tool Claude Code has, or a field would make Claude Code refuse the
 * plugin.
 */
export function claudePluginFiles(options: ClaudePluginOptions): Record<string, string> {
  const { plugin, version, description, author, homepage, repository, license, keywords, marketplace } = options
  const matcher = requireMatcher('claude', plugin)
  const entry = entryOf(options.entry)
  if (RESERVED.test(plugin.name))
    throw new TypeError(`Claude Code reserves plugin names like ${plugin.name} for Anthropic's own; name it for what it does`)
  if (homepage !== undefined && !URL.canParse(homepage))
    throw new TypeError(`homepage ${JSON.stringify(homepage)} is not a URL`)
  const files: Record<string, string> = {
    '.claude-plugin/plugin.json': json({ name: plugin.name, version, description, author, homepage, repository, license, keywords }),
    'hooks/hooks.json': json({ hooks: pluginHooks(plugin, matcher, entry) }),
  }
  if (marketplace) {
    if (!MARKETPLACE_NAME.test(marketplace.name))
      throw new TypeError(`marketplace name ${JSON.stringify(marketplace.name)} may hold only letters, digits, '.', '_' and '-', and must start with a letter or digit`)
    files['.claude-plugin/marketplace.json'] = json({
      name: marketplace.name,
      owner: marketplace.owner,
      description,
      plugins: [{
        name: plugin.name,
        // The build is not in git, so the plugin comes from the npm package,
        // which holds it.
        source: { source: 'npm', package: plugin.packageName, version: marketplace.version },
        description,
      }],
    })
  }
  return files
}

/**
 * Writes {@link claudePluginFiles} under `dir`, the plugin package's root, and
 * returns the paths written. Run it from the package's build, and publish the
 * written files with the build.
 */
export function writeClaudePlugin(dir: string, options: ClaudePluginOptions): string[] {
  return Object.entries(claudePluginFiles(options)).map(([path, text]) => {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return file
  })
}
