import type { HookVerdict } from '../../src'
import { defineHook, runCli } from '../../src'

// A plugin bin as a plugin package would ship it: the toolkit bundled in, so
// the copy install makes runs on its own.
export const plugin = defineHook({
  name: 'toy-bin',
  kinds: ['shell', 'write'],
  check(call): HookVerdict | Promise<HookVerdict> {
    const text = call.kind === 'shell' ? call.command : call.content
    if (text.includes('HANG'))
      return new Promise(() => {})
    return text.includes('FORBIDDEN') ? { block: true, reason: 'toy-bin: FORBIDDEN is not allowed' } : { block: false }
  },
  events: {
    Stop: {
      check({ reply }): HookVerdict | Promise<HookVerdict> {
        if (reply.includes('HANG'))
          return new Promise(() => {})
        return reply.includes('FORBIDDEN') ? { block: true, reason: 'toy-bin: take FORBIDDEN out of the reply' } : { block: false }
      },
    },
  },
})

void runCli(plugin, import.meta.url)
