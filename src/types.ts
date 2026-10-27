/**
 * What a hook declares it checks. Each kind selects the agents' tools that
 * make that change, and is the `kind` of the {@link ToolCall} the check gets.
 * `tool` selects the tools the definition names in `tools`, such as an MCP
 * server's.
 */
export type ToolKind = 'shell' | 'write' | 'edit' | 'patch' | 'tool'

/**
 * An agent's tool call, reduced to what a check needs. `shell` is Bash in
 * either agent; `write` is Claude Code's Write or NotebookEdit; `edit` is Edit,
 * or one edit of a MultiEdit, which the check gets edit by edit; `patch` is
 * Codex's apply_patch, the whole patch text, which can add, change and delete
 * files; `tool` is one of the tools named in `tools`, with its input as the
 * agent sent it, an object.
 */
export type ToolCall
  = | { kind: 'shell', command: string }
    | { kind: 'write', path: string, content: string }
    | { kind: 'edit', path: string, before: string, after: string }
    | { kind: 'patch', patch: string }
    | { kind: 'tool', name: string, input: Readonly<Record<string, unknown>> }

/** What a check declared with kinds `K` receives: only the matching shapes of {@link ToolCall}. */
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

/**
 * The agent events a hook takes part in. Every hook has PreToolUse, which
 * fails closed; Stop and UserPromptSubmit are optional and fail open, since a
 * hook that cannot run must not trap the session in a loop or swallow every
 * prompt.
 */
export type HookEvent = 'PreToolUse' | 'Stop' | 'UserPromptSubmit'

/** What a Stop check gets: the reply the agent is about to end its turn on. */
export interface StopInput {
  reply: string
}

/** What a UserPromptSubmit check gets: the prompt the user sent. */
export interface PromptInput {
  prompt: string
}

/**
 * A check on one event other than PreToolUse. A block makes the agent take
 * the reason instead: at Stop it keeps going with the reason as its next
 * instruction, at UserPromptSubmit it drops the prompt and shows the reason.
 * A check that throws or returns anything but a verdict lets the event pass.
 */
export interface EventDefinition<I> {
  check: (input: I, context: HookContext) => HookVerdict | Promise<HookVerdict>
  /** What the agent shows while the check runs. Defaults to the hook's `statusMessage`. */
  statusMessage?: string
  /** Seconds the agent waits. Defaults to the hook's `timeout`; past it, the event passes. */
  timeout?: number
}

export interface PromptDefinition extends EventDefinition<PromptInput> {
  /**
   * Keeps Claude Code from printing the blocked prompt back under the reason,
   * for a check that blocks a prompt because of what it holds, such as a
   * secret.
   */
  hidePrompt?: boolean
}

/** The events a hook adds on top of PreToolUse. */
export interface EventDefinitions {
  Stop?: EventDefinition<StopInput>
  UserPromptSubmit?: PromptDefinition
}

/** Where {@link HookDefinition.onInstall} and `onUninstall` run. */
export interface InstallPlace {
  agent: Agent
  scope: Scope
  home: string
  cwd: string
  /** The built bin install runs from, to find files shipped beside it. */
  script: string
  /** The agent config just written. */
  file: string
}

/** Lines an install step adds to what the command line prints. */
export interface InstallNotes {
  /** Printed to stdout after the config file. */
  notes?: readonly string[]
  /** Printed to stderr. */
  warnings?: readonly string[]
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
  /**
   * Commands an earlier version of the hook wrote in a form install no longer
   * recognizes, such as a path that does not sit in a directory named after
   * the hook. A command any pattern matches is taken as this hook's own:
   * install replaces it and uninstall removes it. A pattern must match the
   * whole command, not a part of it, and may not carry the `g`, `m` or `y`
   * flag.
   */
  ownCommands?: readonly RegExp[]
  /**
   * Tools no kind covers, by exact name, such as
   * `mcp__github__create_pull_request`. They reach the check as `tool` calls,
   * so `kinds` must list `tool` exactly when this names any.
   */
  tools?: readonly string[]
  /** Checks on events other than PreToolUse, installed beside it. */
  events?: EventDefinitions
  /**
   * Runs after install writes the config, to set up what else the hook needs,
   * such as files in the agent's directory. Throwing puts the config and the
   * `current` link back as they were and fails the install. Not run for a
   * Claude Code plugin, which Claude Code installs itself.
   */
  onInstall?: (place: InstallPlace) => InstallNotes | void
  /** Runs after uninstall, even when the config held no entry; throwing puts the config back. */
  onUninstall?: (place: InstallPlace) => InstallNotes | void
}

/** An event hook with its defaults filled in. */
export interface EventHook<I> {
  readonly check: (input: I, context: HookContext) => HookVerdict | Promise<HookVerdict>
  readonly statusMessage: string
  readonly timeout: number
}

/** A checked hook definition, as {@link defineHook} returns it. */
export interface HookPlugin {
  readonly name: string
  readonly packageName: string
  readonly kinds: readonly ToolKind[]
  readonly statusMessage: string
  readonly timeout: number
  readonly ownCommands: readonly RegExp[]
  readonly tools: readonly string[]
  readonly events: Readonly<{ Stop?: EventHook<StopInput>, UserPromptSubmit?: EventHook<PromptInput> & { readonly hidePrompt: boolean } }>
  readonly onInstall?: (place: InstallPlace) => InstallNotes | void
  readonly onUninstall?: (place: InstallPlace) => InstallNotes | void
  /** Called only with a call whose kind is in `kinds`. */
  readonly check: (call: ToolCall, context: HookContext) => HookVerdict | Promise<HookVerdict>
}

/** `claude` installs into `.claude/settings.json`, `codex` into `.codex/hooks.json`. */
export type Agent = 'claude' | 'codex'

/** `user` writes the agent's config in the home directory, `project` the one in the working directory. */
export type Scope = 'user' | 'project'
