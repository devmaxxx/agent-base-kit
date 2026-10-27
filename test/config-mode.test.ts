import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { createCli } from '../src'
import { fakeBuild, place, toyGuard } from './support/toy'

// The mode each sibling `.tmp` file has the moment its text is written, before
// anything can chmod it.
const written = vi.hoisted(() => [] as { path: string, mode: number }[])

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const writeFileSync: typeof fs.writeFileSync = (path, ...rest) => {
    fs.writeFileSync(path, ...rest)
    if (typeof path === 'string' && path.endsWith('.tmp'))
      written.push({ path, mode: fs.statSync(path).mode & 0o777 })
  }
  return { ...fs, default: { ...fs, writeFileSync }, writeFileSync }
})

describe('the config install writes', () => {
  const script = fakeBuild()
  const install = async (where: { home: string, cwd: string }): Promise<number> => createCli(toyGuard())(['install', 'claude'], {
    stdin: () => '',
    script,
    node: 'v22.0.0',
    execPath: process.execPath,
    ...where,
    stdout: () => {},
    stderr: () => {},
  })
  const config = () => {
    const where = place()
    const file = join(where.home, '.claude/settings.json')
    mkdirSync(dirname(file))
    return { where, file }
  }

  it('never holds a 0600 config\'s text at a wider mode, and keeps the mode', async () => {
    for (const mode of [0o600, 0o640, 0o644]) {
      const { where, file } = config()
      writeFileSync(file, '{"env":{"TOKEN":"secret"}}')
      chmodSync(file, mode)
      written.length = 0
      expect(await install(where)).toBe(0)
      expect(written.map(write => write.mode), mode.toString(8)).toEqual([mode])
      expect(statSync(file).mode & 0o777).toBe(mode)
    }
  })

  it('replaces a sibling a killed run left at a wider mode instead of writing into it', async () => {
    const { where, file } = config()
    writeFileSync(file, '{}')
    chmodSync(file, 0o600)
    const stale = `${file}.${process.pid}.tmp`
    writeFileSync(stale, 'left over')
    chmodSync(stale, 0o644)
    written.length = 0
    expect(await install(where)).toBe(0)
    expect(written.at(-1)!.mode).toBe(0o600)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSync(stale)).toBe(false)
  })

  it('creates a new config at 0666 less the umask', async () => {
    const { where, file } = config()
    expect(await install(where)).toBe(0)
    expect(statSync(file).mode & 0o777).toBe(0o666 & ~process.umask())
    expect(readdirSync(dirname(file))).toEqual(['settings.json'])
  })
})
