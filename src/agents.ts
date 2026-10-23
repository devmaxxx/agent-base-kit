import type { Agent, HookPlugin, ToolKind } from './types'

export const AGENTS = {
  claude: { label: 'Claude Code', dir: '.claude', file: 'settings.json' },
  codex: { label: 'Codex', dir: '.codex', file: 'hooks.json' },
} as const satisfies Record<Agent, { label: string, dir: string, file: string }>

// The kind of call each tool arrives as. Bash is shared by both agents.
export const KIND_OF_TOOL: ReadonlyMap<string, ToolKind> = new Map([
  ['Bash', 'shell'],
  ['Write', 'write'],
  ['NotebookEdit', 'write'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['apply_patch', 'patch'],
])

// The tools each agent routes to the hook, with the kinds that select them.
// Codex sends file writes and edits as apply_patch, so asking for either
// selects it.
const SELECTED_BY: Record<Agent, readonly (readonly [string, readonly ToolKind[]])[]> = {
  claude: [['Bash', ['shell']], ['Write', ['write']], ['Edit', ['edit']], ['MultiEdit', ['edit']], ['NotebookEdit', ['write']]],
  codex: [['Bash', ['shell']], ['apply_patch', ['write', 'edit', 'patch']]],
}

function selected(agent: Agent, kinds: readonly ToolKind[]): string[] {
  return SELECTED_BY[agent].filter(([, by]) => by.some(kind => kinds.includes(kind))).map(([tool]) => tool)
}

/**
 * The PreToolUse matcher that routes the given kinds of call to the hook in
 * one agent, such as `Bash|Write|Edit|MultiEdit|NotebookEdit` for every kind
 * in Claude Code; empty when the agent has no tool of those kinds.
 */
export function matcherFor(agent: Agent, kinds: readonly ToolKind[]): string {
  return selected(agent, kinds).join('|')
}

// A matcher that routes calls the check never sees would look installed and
// check nothing, so it is refused with what to change.
export function requireMatcher(agent: Agent, plugin: HookPlugin): string {
  const tools = selected(agent, plugin.kinds)
  if (tools.length === 0)
    throw new Error(`${plugin.name} checks ${plugin.kinds.join(', ')} calls, which ${AGENTS[agent].label} does not make`)
  const unseen = tools.filter(tool => !plugin.kinds.includes(KIND_OF_TOOL.get(tool) as ToolKind))
  if (unseen.length > 0)
    throw new Error(`${AGENTS[agent].label} sends file changes as ${unseen.join(', ')}, which ${plugin.name} does not take; add 'patch' to its kinds`)
  return tools.join('|')
}
