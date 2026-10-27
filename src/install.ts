import type { Agent, HookEvent, HookPlugin, InstallNotes, InstallPlace, Scope } from './types'
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

/** The config file written and, for an install, the commands in it. */
export interface InstallResult {
  file: string
  /** The PreToolUse command. */
  command?: string
  /** The command written for each event. */
  commands?: Partial<Record<HookEvent, string>>
  /** What the plugin's `onInstall` or `onUninstall` returned, for stdout. */
  notes: string[]
  /** And for stderr. */
  warnings: string[]
}

// Every event install writes to, and so every list it takes its own entries
// out of: an entry an earlier version wrote for an event this one dropped is
// removed too.
const EVENTS: readonly HookEvent[] = ['PreToolUse', 'Stop', 'UserPromptSubmit']

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
// path to it. Single quotes keep the shell from expanding a `$` in the path.
//
// A user hook runs on the Node.js that installed it, not on the `node` first
// on PATH, which a project pinning an older version would change under every
// session. Once that Node.js is removed it falls back to PATH, and the CLI
// blocks there with a message when that one is too old.
function hookCommand(plugin: HookPlugin, scope: Scope, script: string, node: string): string {
  if (scope === 'project')
    return `npx --no-install ${plugin.packageName} hook`
  return `n=${quote(node)}; [ -x "$n" ] || n=node; "$n" ${quote(script)} hook`
}

// A missing package or a moved script exits 1, which lets a tool call run, so
// at PreToolUse that becomes a block. The other events pass on any exit but 2,
// which is what they should do when the hook cannot start.
function entriesFor(plugin: HookPlugin, agent: Agent, command: string): Partial<Record<HookEvent, HookEntry>> {
  const entry = (event: HookEvent, status: string, timeout: number): { type: string, command: string, timeout: number, statusMessage: string } =>
    ({ type: 'command', command: event === 'PreToolUse' ? `${command} || exit 2` : command, timeout, statusMessage: status })
  const { Stop, UserPromptSubmit } = plugin.events
  return {
    PreToolUse: {
      matcher: requireMatcher(agent, plugin),
      // Claude Code also blocks the call when the hook cannot start or times
      // out, which `|| exit 2` cannot see. Codex has no such field.
      hooks: [{ ...entry('PreToolUse', plugin.statusMessage, plugin.timeout), ...(agent === 'claude' ? { onFailure: 'block' } : {}) }],
    },
    ...(Stop ? { Stop: { hooks: [entry('Stop', Stop.statusMessage, Stop.timeout)] } } : {}),
    ...(UserPromptSubmit ? { UserPromptSubmit: { hooks: [entry('UserPromptSubmit', UserPromptSubmit.statusMessage, UserPromptSubmit.timeout)] } } : {}),
  }
}

const QUOTED = String.raw`(?:[^']|'\\'')*`

// The exact commands install writes, past and present, so a user hook that
// merely mentions the plugin, or another plugin's hook, is never taken for
// one. Anything under `~/.<name>/current/` is this plugin's own copy, so a
// pinned entry is matched whatever its file name, and survives a renamed bin.
// The bare `node '<path>' hook` form predates the pinned Node.js and the copy,
// when the path was wherever the package sat; it needs a directory named
// exactly after the plugin. Commands written before `|| exit 2` lack it.
// Forms only the plugin knows it wrote come from its `ownCommands`, each
// wrapped to match the whole command: unanchored, or anchored on one side of
// an alternation only, it would take another hook's entry for this one.
function ownHook(plugin: HookPlugin, entry: string): (command: string) => boolean {
  const name = escape(plugin.name)
  const pinned = String.raw`n='${QUOTED}'; \[ -x "\$n" \] \|\| n=node; "\$n" '${QUOTED}/\.${name}/current/[^/']+' hook`
  const bare = `node '${QUOTED}/${name}/(?:${QUOTED}/)?${escape(entry)}' hook`
  const project = `npx --no-install ${escape(plugin.packageName)} hook`
  const own = new RegExp(`^(?:${pinned}|${bare}|${project})(?: \\|\\| exit 2)?$`)
  const earlier = plugin.ownCommands.map(pattern => new RegExp(`^(?:${pattern.source})$`, pattern.flags))
  return command => own.test(command) || earlier.some(pattern => pattern.test(command))
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
  // A `null` where the hooks object or an event's list would go is read as
  // absent, as the agents do, and the hook is written in; a wrong non-null
  // shape would lose what the agent reads, so it is refused.
  const hooks = isObject(settings) ? settings.hooks : undefined
  const wrongHooks = hooks !== undefined && hooks !== null && !isObject(hooks)
  const wrongList = EVENTS.find((event) => {
    const list = isObject(hooks) ? hooks[event] : undefined
    return list !== undefined && list !== null && !Array.isArray(list)
  })
  if (!isObject(settings) || wrongHooks)
    throw new Error(`${file} does not hold a settings object with a hooks object; it was left unchanged`)
  if (wrongList)
    throw new Error(`${file} has a ${wrongList} that is not a list; it was left unchanged`)
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

// Drops every earlier entry of this plugin first, in each event's list, so
// installing twice or after a move leaves exactly one hook per event pointing
// at the current build. Entries it does not understand are kept as they are.
// With nothing to add or remove the file is not rewritten, so an uninstall
// that finds no hook keeps its formatting.
function configure(file: string, settings: Settings, own: (command: string) => boolean, entries: Partial<Record<HookEvent, HookEntry>>): void {
  const hooks = { ...settings.hooks }
  let changed = false
  for (const event of EVENTS) {
    const before = Array.isArray(hooks[event]) ? hooks[event] : []
    const kept = before
      .map((item) => {
        if (!Array.isArray(item?.hooks))
          return item
        const rest = item.hooks.filter(hook => !(typeof hook?.command === 'string' && own(hook.command)))
        changed ||= rest.length < item.hooks.length
        return { ...item, hooks: rest }
      })
      .filter(item => !Array.isArray(item?.hooks) || item.hooks.length > 0)
    const entry = entries[event]
    if (entry) {
      kept.push(entry)
      changed = true
    }
    if (kept.length > 0)
      hooks[event] = kept
    else if (Array.isArray(hooks[event]))
      delete hooks[event]
  }
  if (!changed)
    return
  settings.hooks = hooks
  writeConfig(file, `${JSON.stringify(settings, null, 2)}\n`)
}

function linesOf(value: unknown, field: string): string[] {
  if (value === undefined)
    return []
  if (!Array.isArray(value) || value.some(line => typeof line !== 'string'))
    throw new TypeError(`${field} is not a list of strings`)
  return [...value]
}

// The extra step runs once the config is written, and a step that fails puts
// the config back as it was, so the hook is never left installed without
// what it needs, or removed while that stays.
function withExtra(file: string, place: Omit<InstallPlace, 'file'>, write: () => void, extra: ((place: InstallPlace) => InstallNotes | void) | undefined): { notes: string[], warnings: string[] } {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null
  write()
  if (!extra)
    return { notes: [], warnings: [] }
  try {
    const result: unknown = extra({ ...place, file })
    if (result !== undefined && !isObject(result))
      throw new TypeError('an install step returned neither nothing nor { notes, warnings }')
    return { notes: linesOf(result?.notes, 'notes'), warnings: linesOf(result?.warnings, 'warnings') }
  }
  catch (error) {
    if (before === null)
      rmSync(file, { force: true })
    else if (readFileSync(file, 'utf8') !== before)
      writeConfig(file, before)
    throw error
  }
}

/**
 * Adds the plugin's hooks to one agent's config, PreToolUse and each event in
 * its `events`, replacing any entry it wrote before, for any event, and
 * keeping every other one.
 *
 * The user scope copies the bin's directory to `~/.<name>/<build-id>/`, checks
 * the copy runs, points `~/.<name>/current` at it and runs it from there on
 * `execPath`. The project scope runs `npx --no-install <packageName> hook`.
 * The PreToolUse command ends in `|| exit 2`, so a hook that cannot start
 * blocks the call, and the Claude Code entry sets `onFailure: "block"` for one
 * that times out. The other events' commands do not, so they pass instead.
 * Then the plugin's `onInstall` runs.
 *
 * Throws, and leaves the config as it was, when the config is not a settings
 * object it can extend, when the plugin's kinds leave tools the agent routes
 * to it unchecked, when the build cannot be copied or does not run, or when
 * `onInstall` throws.
 */
export function install(options: InstallOptions): InstallResult {
  const { plugin, agent, scope, script } = options
  requireMatcher(agent, plugin)
  const file = configFile(agent, scope, options)
  const settings = readSettings(file)
  let target = script
  if (scope === 'user') {
    const root = join(options.home, `.${plugin.name}`)
    const id = copyBuild(plugin, script, root)
    probe(join(root, id, basename(script)), options.execPath)
    target = join(linkCurrent(root, id), basename(script))
  }
  const entries = entriesFor(plugin, agent, hookCommand(plugin, scope, target, options.execPath))
  const place = { agent, scope, home: options.home, cwd: options.cwd, script }
  const lines = withExtra(file, place, () => configure(file, settings, ownHook(plugin, basename(script)), entries), plugin.onInstall)
  const commands = Object.fromEntries(Object.entries(entries).map(([event, entry]) => [event, entry.hooks![0]!.command as string]))
  return { file, command: commands.PreToolUse, commands, ...lines }
}

/**
 * Removes the plugin's hooks from one agent's config, for every event and
 * whichever form an earlier install wrote, keeps every other entry, and runs
 * the plugin's `onUninstall`. The stable copy stays: another agent may still
 * run it. Throws, and leaves the file as it was, when it is not a settings
 * object or `onUninstall` throws.
 */
export function uninstall(options: UninstallOptions): InstallResult {
  const { plugin, agent, scope, script } = options
  const file = configFile(agent, scope, options)
  const place = { agent, scope, home: options.home, cwd: options.cwd, script }
  return { file, ...withExtra(file, place, () => {
    if (existsSync(file))
      configure(file, readSettings(file), ownHook(plugin, basename(script)), {})
  }, plugin.onUninstall) }
}
