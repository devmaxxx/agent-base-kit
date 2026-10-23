/** A kind of tool call a hook can ask to check. */
export type ToolKind = 'shell' | 'write' | 'edit' | 'patch'

/**
 * An agent's tool call, reduced to what a check needs. `shell` is Bash in
 * either agent; `write` is Claude Code's Write or NotebookEdit; `edit` is Edit
 * or MultiEdit, whose edits arrive joined by newlines; `patch` is Codex's
 * apply_patch, the whole patch text, which can add, change and delete files.
 */
export type ToolCall
  = | { kind: 'shell', command: string }
    | { kind: 'write', path: string, content: string }
    | { kind: 'edit', path: string, before: string, after: string }
    | { kind: 'patch', patch: string }

/** The calls of the given kinds. */
export type ToolCallOf<K extends ToolKind> = Extract<ToolCall, { kind: K }>

/**
 * What a check decides. A block's `reason` is printed to stderr as it is, and
 * the agent shows it to the model, so it should name the hook and say what to
 * do instead.
 */
export type HookVerdict = { block: false } | { block: true, reason: string }

/** Where the call runs. */
export interface HookContext {
  /** The agent's working directory, from the payload, else the hook's own. */
  cwd: string
}

/** What a plugin author writes; {@link defineHook} checks it and fills in the defaults. */
export interface HookDefinition<K extends ToolKind> {
  /**
   * Kebab-case. It names the stable copy (`~/.<name>/`), the Claude Code
   * plugin, and the commands install recognizes as its own.
   */
  name: string
  /**
   * The calls to check. The agents' matchers are derived from it, and the
   * check is only ever handed a call of one of these kinds. Codex sends every
   * file change as one apply_patch, so a hook that takes `write` or `edit`
   * must take `patch` too before it can be installed for Codex.
   */
  kinds: readonly K[]
  /**
   * Decides one call. Throwing, rejecting or returning anything but a verdict
   * blocks the call.
   */
  check: (call: ToolCallOf<K>, context: HookContext) => HookVerdict | Promise<HookVerdict>
  /** The npm package whose bin runs the hook; a project install runs it through npx. Defaults to `name`. */
  packageName?: string
  /** What the agent shows while the hook runs. Defaults to `Running <name>`. */
  statusMessage?: string
  /**
   * Seconds the agent waits for the hook. Defaults to 10. Past it Codex lets
   * the call run, and Claude Code blocks it.
   */
  timeout?: number
}

/** A checked hook definition, as {@link defineHook} returns it. */
export interface HookPlugin {
  readonly name: string
  readonly packageName: string
  readonly kinds: readonly ToolKind[]
  readonly statusMessage: string
  readonly timeout: number
  /** Called only with a call whose kind is in `kinds`. */
  readonly check: (call: ToolCall, context: HookContext) => HookVerdict | Promise<HookVerdict>
}

/** The agents a hook installs into. */
export type Agent = 'claude' | 'codex'

/** `user` writes the agent's config in the home directory, `project` the one in the working directory. */
export type Scope = 'user' | 'project'
