import type { Agent, HookPlugin } from './types'
import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runHook } from './hook'
import { install, uninstall } from './install'

/** What the command line needs from its process, passed in so tests can supply it. */
export interface CliIO {
  /** The tool call, read only by `hook`. */
  stdin: () => string
  /** The built bin the installed hook runs. */
  script: string
  /** The running Node.js version, as `process.version` gives it. */
  node: string
  /** The running Node.js executable, which a user-scope hook keeps running on. */
  execPath: string
  /** Holds the user-scope config and the stable copy of the build. */
  home: string
  /** Holds the project-scope config, and is the hook's working directory when the payload names none. */
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** How the command names itself. */
export interface CliOptions {
  /** The command name in usage and error text, for a bin not named after the plugin. Defaults to the plugin's name. */
  bin?: string
}

const isAgent = (word: string | undefined): word is Agent => word === 'claude' || word === 'codex'

/** Runs one command line and resolves to its exit code. */
export type CliMain = (argv: readonly string[], io: CliIO) => Promise<number>

function usage(bin: string): string {
  const rows = [
    ['install <claude|codex> [--project]', 'add the PreToolUse hook'],
    ['uninstall <claude|codex> [--project]', 'remove it'],
    ['hook', 'run as the hook (reads the tool call on stdin)'],
  ]
  const width = Math.max(...rows.map(([command]) => command!.length)) + 1
  return `Usage:\n${rows.map(([command, what]) => `  ${bin} ${command!.padEnd(width)}${what}`).join('\n')}\n`
}

/**
 * Builds the plugin's command line: `install` and `uninstall <claude|codex>
 * [--project]`, and `hook`, which reads the tool call from `io.stdin`.
 *
 * Exit codes: `hook` returns what {@link runHook} returns, 0 or 2. `install`
 * and `uninstall` return 0, or 1 with the reason on stderr. Anything else,
 * including an unknown flag or an extra argument, prints the usage and
 * returns 1. On a Node.js older than 22, `hook` returns 2
 * and `install` 1, each with a message naming the fix; `uninstall` still runs.
 */
export function createCli(plugin: HookPlugin, options: CliOptions = {}): CliMain {
  const bin = options.bin ?? plugin.name
  return async (argv, io) => {
    const [command, agent, ...flags] = argv
    // A user hook falls back to the `node` first on PATH once the Node.js that
    // installed it is gone, so an older one can reach it. Nothing below 22 is
    // tested, and a check that misbehaves there could let a call through, so
    // it blocks and says why. Removing the hook needs no check, so `uninstall`
    // still runs.
    const major = Number(/^v(\d+)\./.exec(io.node)?.[1] ?? 0)
    if ((command === 'hook' || command === 'install') && major < 22) {
      io.stderr(`${bin} needs Node.js 22 or later, and this one is ${io.node}. Run \`npx ${plugin.packageName} install claude\` (or codex) again with Node.js 22 or later, or put one first on PATH and restart the agent.\n`)
      return command === 'hook' ? 2 : 1
    }
    if (command === 'hook')
      return runHook(plugin, io.stdin(), { cwd: io.cwd, stderr: io.stderr })
    // A mistyped `--project` must not fall back to the user scope, which an
    // uninstall would then remove the wrong hook from.
    const project = flags.length === 1 && flags[0] === '--project'
    if ((command === 'install' || command === 'uninstall') && isAgent(agent) && (flags.length === 0 || project)) {
      const place = { plugin, agent, scope: project ? 'project' as const : 'user' as const, script: io.script, home: io.home, cwd: io.cwd }
      let file: string
      try {
        file = command === 'install' ? install({ ...place, execPath: io.execPath }).file : uninstall(place).file
      }
      catch (error) {
        io.stderr(`${bin}: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
      io.stdout(`${command === 'install' ? 'Installed in' : 'Removed from'} ${file}\n`)
      if (command === 'install' && agent === 'codex')
        io.stdout('Codex runs a new hook only after you trust it: open /hooks in Codex once.\n')
      return 0
    }
    io.stderr(usage(bin))
    return 1
  }
}

/**
 * Reads a stream to its end as UTF-8, `process.stdin` by default. A
 * synchronous read of fd 0 fails with EAGAIN on a non-blocking pipe once the
 * payload outgrows its buffer, so the hook reads this way. A read that fails
 * resolves to `''`, which {@link runHook} blocks.
 */
export async function readStdin(stream: AsyncIterable<unknown> = process.stdin): Promise<string> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of stream)
      chunks.push(Buffer.from(chunk as Uint8Array))
  }
  catch {
    return ''
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The whole bin: runs {@link createCli} on `process.argv`, reads stdin only for
 * `hook`, and sets `process.exitCode`. Call it without `await`, passing the
 * bin's own `import.meta.url`, which is what install copies and runs.
 *
 * For `hook` the exit code is 2 until a verdict is in. Node.js exits 0 once
 * nothing is left to run, so a check whose promise never settles would
 * otherwise let the call run.
 */
export async function runCli(plugin: HookPlugin, entryUrl: string, options: CliOptions = {}): Promise<void> {
  const argv = process.argv.slice(2)
  const hook = argv[0] === 'hook'
  let done = false
  if (hook) {
    process.exitCode = 2
    process.once('beforeExit', () => {
      if (!done)
        process.stderr.write(`Blocked by ${plugin.name}, its check never finished\n`)
    })
  }
  try {
    const input = hook ? await readStdin() : ''
    process.exitCode = await createCli(plugin, options)(argv, {
      stdin: () => input,
      script: fileURLToPath(entryUrl),
      node: process.version,
      execPath: process.execPath,
      home: homedir(),
      cwd: process.cwd(),
      stdout: text => void process.stdout.write(text),
      stderr: text => void process.stderr.write(text),
    })
    done = true
  }
  catch (error) {
    done = true
    process.stderr.write(`${options.bin ?? plugin.name}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = hook ? 2 : 1
  }
}
