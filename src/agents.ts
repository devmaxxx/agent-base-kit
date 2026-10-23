import type { Agent, HookPlugin, ToolKind } from './types'

export const AGENTS = {
  claude: { label: 'Claude Code', dir: '.claude', file: 'settings.json' },
  codex: { label: 'Codex', dir: '.codex', file: 'hooks.json' },
} as const satisfies Record<Agent, { label: string, dir: string, file: string }>

// The one place a tool is named: the matchers and the hook's reading of a
// payload both derive from it, so neither can route a tool the other skips.
const TOOLS: Record<Agent, Readonly<Record<string, ToolKind>>> = {
  claude: { Bash: 'shell', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'write' },
  codex: { Bash: 'shell', apply_patch: 'patch' },
}

// Codex sends file writes and edits as apply_patch, so asking for either
// selects it.
const SELECTED_BY: Record<ToolKind, readonly ToolKind[]> = {
  shell: ['shell'],
  write: ['write'],
  edit: ['edit'],
  patch: ['write', 'edit', 'patch'],
}

// The hook is not told which agent called it, so a tool name means the same
// kind in both.
export const KIND_OF_TOOL: ReadonlyMap<string, ToolKind> = new Map(Object.values(TOOLS).flatMap(tools => Object.entries(tools)))

function selected(agent: Agent, kinds: readonly ToolKind[]): [string, ToolKind][] {
  return Object.entries(TOOLS[agent]).filter(([, kind]) => SELECTED_BY[kind].some(by => kinds.includes(by)))
}

/**
 * The PreToolUse matcher that routes the given kinds of call to the hook in
 * one agent, such as `Bash|Write|Edit|MultiEdit|NotebookEdit` for every kind
 * in Claude Code; empty when the agent has no tool of those kinds.
 */
export function matcherFor(agent: Agent, kinds: readonly ToolKind[]): string {
  return selected(agent, kinds).map(([tool]) => tool).join('|')
}

// A matcher that routes calls the check never sees would look installed and
// check nothing, so it is refused with what to change.
export function requireMatcher(agent: Agent, plugin: HookPlugin): string {
  const tools = selected(agent, plugin.kinds)
  if (tools.length === 0)
    throw new Error(`${plugin.name} checks ${plugin.kinds.join(', ')} calls, which ${AGENTS[agent].label} does not make`)
  const unseen = tools.filter(([, kind]) => !plugin.kinds.includes(kind)).map(([tool]) => tool)
  if (unseen.length > 0)
    throw new Error(`${AGENTS[agent].label} sends file changes as ${unseen.join(', ')}, which ${plugin.name} does not take; add 'patch' to its kinds`)
  return tools.map(([tool]) => tool).join('|')
}
