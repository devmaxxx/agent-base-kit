<div align="center">

<img src="docs/assets/logo.svg" width="96" height="96" alt="">

# agent-base-kit

**The base kit for Claude Code and Codex hooks.**

[![npm version](https://img.shields.io/npm/v/agent-base-kit?color=cb3837)](https://www.npmjs.com/package/agent-base-kit)
[![npm downloads](https://img.shields.io/npm/dm/agent-base-kit)](https://www.npmjs.com/package/agent-base-kit)
[![CI](https://github.com/devmaxxx/agent-base-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/devmaxxx/agent-base-kit/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/agent-base-kit)](https://www.npmjs.com/package/agent-base-kit)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![node](https://img.shields.io/node/v/agent-base-kit)](./package.json)
[![license: MIT](https://img.shields.io/npm/l/agent-base-kit)](./LICENSE)

[Why](#why) · [What you get](#what-you-get) · [Usage](#usage) · [What install writes](#what-install-writes) · [Fail-closed](#the-fail-closed-contract) · [Kinds](#kinds-and-matchers) · [API](#api)

</div>

## Why

A [PreToolUse hook](https://code.claude.com/docs/en/hooks) is the last point where you can stop an agent's tool call. Every hook needs the same plumbing before its own check: read the agent's payload, write the agent's config without breaking anyone else's entries, keep running across Node.js upgrades, and block when the check cannot run, since the agents treat every exit except 2 as "go on".

agent-base-kit is that plumbing, shared by every hook you build. You write the check; reuse the rest for a secret scanner, a policy guard, or any other hook.

## What you get

- **One function to write.** `check(call)` gets a typed call (`shell`, `write`, `edit` or `patch`) and returns `{ block, reason }`, sync or async.
- **Both agents.** Claude Code and Codex, with matchers derived from the kinds you list.
- **Fail-closed by default.** Unreadable payloads, throws, bad verdicts, hangs and a hook that cannot start all block.
- **One command to install.** Your bin gets `install` and `uninstall` for `claude` or `codex`, at user or project scope.
- **Other hooks left alone.** Install and uninstall touch only their own entry, and refuse a config they cannot extend safely.
- **Survives upgrades.** A user install runs its own copy of your build on the Node.js that installed it, so an nvm or Homebrew upgrade or a rebuild does not switch it off.
- **Claude Code plugin files.** One call writes the manifest, `hooks.json` and a marketplace.
- **Zero dependencies**, ESM only, typed.

## Usage

```sh
pnpm add -D agent-base-kit
```

Write the check and hand it to `runCli` in your bin:

```ts
#!/usr/bin/env node
import { defineHook, runCli } from 'agent-base-kit'

const plugin = defineHook({
  name: 'no-force-push',
  kinds: ['shell'],
  check: call => /\bgit\s+push\b.*\s(?:-f|--force)(?:\s|$)/.test(call.command)
    ? { block: true, reason: 'Blocked by no-force-push: push without --force, or use --force-with-lease.' }
    : { block: false },
})

void runCli(plugin, import.meta.url)
```

Bundle the bin into `.mjs` files with agent-base-kit inlined, for example with tsdown, since the stable copy has no `node_modules`. Your users then run:

```sh
npx no-force-push install claude            # ~/.claude/settings.json
npx no-force-push install codex --project   # ./.codex/hooks.json
npx no-force-push uninstall claude
```

Requires Node.js 22 or later and a POSIX shell.

## What install writes

A user install (the default scope) does four things:

1. **Copies the build.** The `.mjs` files beside your bin go to `~/.<name>/<build-id>/`, where the id is a hash of their content. The same build reuses its directory, a new build gets a new one, and the copy is staged and renamed in, so a hook never loads a half-written one.
2. **Runs the copy once.** Before any config points at it, the copy runs on a tool no kind covers. If it cannot start, `install` refuses and changes nothing.
3. **Swaps `~/.<name>/current`.** One rename moves the link to the new build, so the hook command stays the same across versions and Codex keeps trusting it.
4. **Writes the hook:**

```sh
n='/path/to/the/installing/node'; [ -x "$n" ] || n=node; "$n" '/home/you/.<name>/current/cli.mjs' hook || exit 2
```

`--project` writes `npx --no-install <packageName> hook || exit 2` instead, which is safe to commit. Uninstall removes the entry and leaves the copy, since another agent may still run it.

Install replaces any entry it wrote before and keeps every other one. It refuses, and changes nothing, when the settings file is not JSON or not an object with a `hooks` object and a `PreToolUse` list, or when `~/.<name>/current` exists and is not a link.

## The fail-closed contract

The hook exits 0 only when your check passes the call:

| What happens | Exit |
| --- | --- |
| `check` returns `{ block: false }` | 0 |
| `check` returns `{ block: true, reason }` (the reason goes to stderr as is) | 2 |
| `check` throws, rejects, never settles, or returns anything else | 2 |
| The payload is not JSON, names no tool, or has a field of the wrong shape | 2 |
| The tool is not one of your kinds | 0, and `check` is not called |
| The hook cannot start: Node.js is missing, the build was deleted, a dependency was not bundled | 2, from `\|\| exit 2` |
| The hook runs on a Node.js older than 22 | 2, with a message naming the fix |
| The hook times out | Claude Code blocks it (`onFailure: "block"`, Claude Code 2.1.295 or later). Codex lets the call run. |

Keep `check` well inside `timeout`, which defaults to 10 seconds.

## Kinds and matchers

`kinds` decides which calls reach your check, and each agent's matcher is derived from it.

| Kind | The call your check gets | Claude Code tools | Codex tools |
| --- | --- | --- | --- |
| `shell` | `{ kind: 'shell', command }` | `Bash` | `Bash` |
| `write` | `{ kind: 'write', path, content }` | `Write`, `NotebookEdit` | `apply_patch` |
| `edit` | `{ kind: 'edit', path, before, after }` (a MultiEdit's edits joined by newlines) | `Edit`, `MultiEdit` | `apply_patch` |
| `patch` | `{ kind: 'patch', patch }` (the whole patch text) | none | `apply_patch` |

Codex sends every file change as one `apply_patch`, so `install codex` refuses a plugin with `write` or `edit` but no `patch`. A plugin with no tool in an agent, such as `['patch']` for Claude Code, is refused too.

## API

```ts
function defineHook<const K extends ToolKind>(definition: HookDefinition<K>): HookPlugin
function runCli(plugin: HookPlugin, entryUrl: string, options?: { bin?: string }): Promise<void>
function createCli(plugin: HookPlugin, options?: { bin?: string }): (argv: readonly string[], io: CliIO) => Promise<number>
function runHook(plugin: HookPlugin, stdin: string, options?: { cwd?: string, stderr?: (text: string) => void }): Promise<number>
function readStdin(stream?: AsyncIterable<unknown>): Promise<string>
function install(options: InstallOptions): { file: string, command?: string }
function uninstall(options: UninstallOptions): { file: string }
function configFile(agent: Agent, scope: Scope, place: { home: string, cwd: string }): string
function matcherFor(agent: Agent, kinds: readonly ToolKind[]): string
function claudePluginFiles(options: ClaudePluginOptions): Record<string, string>
function writeClaudePlugin(dir: string, options: ClaudePluginOptions): string[]
```

`runCli` is the only function that reads the home directory, the working directory and the Node.js path from the process; the others take them as arguments, which keeps tests away from your real `~`. `writeClaudePlugin` writes the files to ship the same hook as a Claude Code plugin instead; use either the plugin or `install claude`, not both.

## Contributing

```sh
git clone https://github.com/devmaxxx/agent-base-kit.git
cd agent-base-kit
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

## License

[MIT](./LICENSE)
