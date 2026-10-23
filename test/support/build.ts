import { execFileSync } from 'node:child_process'

// The bin tests run the toy plugin as a plugin package ships it: built, with
// the toolkit source bundled in.
export default function setup(): void {
  execFileSync('pnpm', ['exec', 'tsdown', '--no-config', '--no-dts', 'test/fixtures/toy-bin.ts', '-d', 'test/fixtures/dist', '--logLevel', 'error'], { stdio: 'pipe' })
}
