import type { Agent, HookPlugin, Scope } from './types'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { AGENTS, requireMatcher } from './agents'

/** Where {@link uninstall} looks: everything is passed in, so nothing reaches past what the caller names. */
export interface UninstallOptions {
  plugin: HookPlugin
  agent: Agent
  scope: Scope
  /** The built bin the hook runs; its file name also picks out entries written before the stable copy existed. */
  script: string
  /** Holds the user-scope config and the stable copy of the build. */
  home: string
  /** Holds the project-scope config. */
  cwd: string
}

/** What {@link install} needs on top of {@link UninstallOptions}. */
export interface InstallOptions extends UninstallOptions {
  /** The Node.js a user-scope hook keeps running on, as `process.execPath` gives it. */
  execPath: string
}

/** The config file written and, for an install, the command in it. */
export interface InstallResult {
  file: string
  command?: string
}

interface HookEntry {
  matcher?: string
  hooks?: { type?: string, command?: unknown, timeout?: number, statusMessage?: string, onFailure?: string }[]
}
interface Settings { hooks?: Record<string, HookEntry[] | null> | null }

/** The agent config a scope writes: `~/.claude/settings.json`, `<cwd>/.codex/hooks.json` and so on. */
export function configFile(agent: Agent, scope: Scope, place: { home: string, cwd: string }): string {
  const { dir, file } = AGENTS[agent]
  return join(scope === 'project' ? place.cwd : place.home, dir, file)
}

const quote = (word: string): string => `'${word.replaceAll('\'', `'\\''`)}'`
const escape = (text: string): string => text.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')

// A project config is committed, so it names the package, not this machine's
// path to it. A missing package or a moved script exits 1, which would let
// every call run, so that becomes a block. Single quotes keep the shell from
// expanding a `$` in the path.
//
// A user hook runs on the Node.js that installed it, not on the `node` first
// on PATH, which a project pinning an older version would change under every
// session. Once that Node.js is removed it falls back to PATH, and the CLI
// blocks there with a message when that one is too old.
function hookCommand(plugin: HookPlugin, scope: Scope, script: string, node: string): string {
  if (scope === 'project')
    return `npx --no-install ${plugin.packageName} hook || exit 2`
  return `n=${quote(node)}; [ -x "$n" ] || n=node; "$n" ${quote(script)} hook || exit 2`
}

const QUOTED = String.raw`(?:[^']|'\\'')*`

// The exact commands install writes, past and present, so a user hook that
// merely mentions the plugin, or another plugin's hook, is never taken for
// one. Anything under `~/.<name>/current/` is this plugin's own copy, so a
// pinned entry is matched whatever its file name, and survives a renamed bin.
// The bare `node '<path>' hook` form predates the pinned Node.js and the copy,
// when the path was wherever the package sat; it needs a directory named
// exactly after the plugin. Commands written before `|| exit 2` lack it.
function ownHook(plugin: HookPlugin, entry: string): RegExp {
  const name = escape(plugin.name)
  const pinned = String.raw`n='${QUOTED}'; \[ -x "\$n" \] \|\| n=node; "\$n" '${QUOTED}/\.${name}/current/[^/']+' hook`
  const bare = `node '${QUOTED}/${name}/(?:${QUOTED}/)?${escape(entry)}' hook`
  const project = `npx --no-install ${escape(plugin.packageName)} hook`
  return new RegExp(`^(?:${pinned}|${bare}|${project})(?: \\|\\| exit 2)?$`)
}

const builtFiles = (dir: string): string[] => readdirSync(dir).filter(name => name.endsWith('.mjs')).sort()

function buildId(dir: string): string {
  const hash = createHash('sha256')
  for (const name of builtFiles(dir))
    hash.update(name).update('\0').update(readFileSync(join(dir, name)))
  return hash.digest('hex').slice(0, 12)
}

// A user hook outlives the copy of the package that installed it: an nvm or
// Homebrew Node upgrade deletes the old version's global packages, and a
// rebuild of a checkout would change the check under every running session.
// So the hook runs its own copy of this build, in a directory named after the
// build's content: reinstalling the same build reuses it, a new build gets a
// new one, and an entry another agent still points at is never overwritten.
// The copy is staged and renamed in, so a hook never loads a half-written one,
// and a directory whose content no longer matches its name is copied again.
function copyBuild(plugin: HookPlugin, script: string, root: string): string {
  if (!script.endsWith('.mjs') || !existsSync(script))
    throw new Error(`${script} is not a built ${plugin.name} entry; run install from the published package or a build`)
  const source = dirname(script)
  const id = buildId(source)
  const target = join(root, id)
  if (!existsSync(target) || buildId(target) !== id) {
    mkdirSync(root, { recursive: true })
    const staging = mkdtempSync(`${target}-`)
    try {
      for (const name of builtFiles(source))
        copyFileSync(join(source, name), join(staging, name))
      // A directory here is either a concurrent install's finished copy of
      // this build, which may already be in use and is kept, or one whose
      // content no longer matches its name, which is moved aside and replaced.
      if (existsSync(target) && buildId(target) !== id)
        renameSync(target, `${staging}-stale`)
      if (!existsSync(target))
        renameSync(staging, target)
    }
    catch (error) {
      // Another install of the same build got there first.
      if (!existsSync(target) || buildId(target) !== id)
        throw error
    }
    finally {
      rmSync(staging, { recursive: true, force: true })
      rmSync(`${staging}-stale`, { recursive: true, force: true })
    }
  }
  return id
}

// Only the .mjs files beside the bin are copied, so a build that imports a
// package from node_modules, or a file in a subdirectory, loads where it was
// built and fails in the copy: the hook would then exit 1 on every call. The
// copy runs once before anything points at it, on a tool no kind covers, which
// loads the whole build and passes without calling the check.
function probe(file: string, node: string): void {
  const ran = spawnSync(node, [file, 'hook'], { input: '{"tool_name":"Read"}', encoding: 'utf8', timeout: 10_000 })
  if (ran.status === 0)
    return
  const why = ran.error?.message ?? ran.stderr.trim().split('\n').find(line => /error/i.test(line)) ?? `exit ${ran.status ?? ran.signal}`
  throw new Error(`the copy of the build at ${file} does not run on its own (${why}); the bin's directory must hold the whole build as .mjs files, with its dependencies bundled in`)
}

// The hook runs the build through the `current` link, swapped by a rename, so
// the command stays the same between versions installed by the same Node.js:
// Codex re-reviews a changed command and skips the hook until it is trusted.
// The build `current` names must stay, or every call blocks until the next
// install.
function linkCurrent(root: string, id: string): string {
  const current = join(root, 'current')
  if (existsSync(current) && !lstatSync(current).isSymbolicLink())
    throw new Error(`${current} is not the link install writes; move it away and install again`)
  const link = `${current}.${process.pid}`
  try {
    rmSync(link, { force: true })
    symlinkSync(id, link)
    renameSync(link, current)
  }
  finally {
    rmSync(link, { force: true })
  }
  return current
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// Rewriting a file of another shape would drop what the agent reads from it,
// so it is refused before anything is written.
function readSettings(file: string): Settings {
  if (!existsSync(file))
    return {}
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); it was left unchanged`)
  }
  // A `null` where the hooks object or the PreToolUse list would go is read as
  // absent, as the agents do, and the hook is written in; a wrong non-null
  // shape would lose what the agent reads, so it is refused.
  const hooks = isObject(settings) ? settings.hooks : undefined
  const preToolUse = isObject(hooks) ? hooks.PreToolUse : undefined
  const wrongHooks = hooks !== undefined && hooks !== null && !isObject(hooks)
  const wrongPreToolUse = preToolUse !== undefined && preToolUse !== null && !Array.isArray(preToolUse)
  if (!isObject(settings) || wrongHooks || wrongPreToolUse)
    throw new Error(`${file} does not hold a settings object with a hooks object and a PreToolUse list; it was left unchanged`)
  return settings as Settings
}

// A write cut short would leave the user's whole config unreadable, so the text
// goes to a sibling file renamed over it. The rename lands on a link's target,
// so a config linked in from a dotfiles repository stays a link, and the file
// keeps its mode.
function writeConfig(file: string, text: string): void {
  const real = existsSync(file) ? realpathSync(file) : file
  mkdirSync(dirname(real), { recursive: true })
  const temp = `${real}.${process.pid}.tmp`
  try {
    writeFileSync(temp, text)
    if (existsSync(real))
      chmodSync(temp, statSync(real).mode & 0o7777)
    renameSync(temp, real)
  }
  finally {
    rmSync(temp, { force: true })
  }
}

// Drops any earlier entry of this plugin first, so installing twice or after a
// move leaves exactly one hook pointing at the current build. Entries it does
// not understand are kept as they are. With nothing to add or remove the file
// is not rewritten, so an uninstall that finds no hook keeps its formatting.
function configure(file: string, settings: Settings, own: RegExp, entry: HookEntry | null): void {
  const hooks = settings.hooks ?? {}
  const before = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  let removed = 0
  const kept = before
    .map((item) => {
      if (!Array.isArray(item?.hooks))
        return item
      const rest = item.hooks.filter(hook => !(typeof hook?.command === 'string' && own.test(hook.command)))
      removed += item.hooks.length - rest.length
      return { ...item, hooks: rest }
    })
    .filter(item => !Array.isArray(item?.hooks) || item.hooks.length > 0)
  if (!entry && removed === 0)
    return
  if (entry)
    kept.push(entry)
  settings.hooks = { ...hooks, PreToolUse: kept }
  if (kept.length === 0)
    delete settings.hooks.PreToolUse
  writeConfig(file, `${JSON.stringify(settings, null, 2)}\n`)
}

/**
 * Adds the plugin's PreToolUse hook to one agent's config, replacing any entry
 * it wrote before and keeping every other one.
 *
 * The user scope copies the bin's directory to `~/.<name>/<build-id>/`, checks
 * the copy runs, points `~/.<name>/current` at it and runs it from there on
 * `execPath`. The project scope runs `npx --no-install <packageName> hook`.
 * Either command ends in `|| exit 2`, so a hook that cannot start blocks the
 * call. The Claude Code entry also sets `onFailure: "block"` for a hook that
 * times out.
 *
 * Throws, and leaves the config as it was, when the config is not a settings
 * object it can extend, when the plugin's kinds leave tools the agent routes
 * to it unchecked, or when the build cannot be copied or does not run.
 */
export function install(options: InstallOptions): InstallResult {
  const { plugin, agent, scope, script } = options
  const matcher = requireMatcher(agent, plugin)
  const file = configFile(agent, scope, options)
  const settings = readSettings(file)
  let target = script
  if (scope === 'user') {
    const root = join(options.home, `.${plugin.name}`)
    const id = copyBuild(plugin, script, root)
    probe(join(root, id, basename(script)), options.execPath)
    target = join(linkCurrent(root, id), basename(script))
  }
  const command = hookCommand(plugin, scope, target, options.execPath)
  configure(file, settings, ownHook(plugin, basename(script)), {
    matcher,
    // Claude Code also blocks the call when the hook cannot start or times
    // out, which `|| exit 2` cannot see. Codex has no such field.
    hooks: [{ type: 'command', command, timeout: plugin.timeout, statusMessage: plugin.statusMessage, ...(agent === 'claude' ? { onFailure: 'block' } : {}) }],
  })
  return { file, command }
}

/**
 * Removes the plugin's hook from one agent's config, whichever form an earlier
 * install wrote, and keeps every other entry. The stable copy stays: another
 * agent may still run it. Throws, and leaves the file as it was, when it is not
 * a settings object.
 */
export function uninstall(options: UninstallOptions): InstallResult {
  const file = configFile(options.agent, options.scope, options)
  if (!existsSync(file))
    return { file }
  configure(file, readSettings(file), ownHook(options.plugin, basename(options.script)), null)
  return { file }
}
