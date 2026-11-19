import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import * as entry from '../src/index.ts'
import { Config, machineOf } from '../src/deployment.ts'

it('imports the complete standalone entry without an installed DSH runtime', () => {
  expect(entry.startApplication).toBeTypeOf('function')
  expect(entry.Runtime).toBeTypeOf('function')
  expect(entry.PaseoRuntime).toBeTypeOf('function')
  expect(entry).not.toHaveProperty('inject')
  expect(entry).not.toHaveProperty('apply')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string>; peerDependencies?: Record<string, string>; dsh?: unknown }
  expect(Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).some(name => name.startsWith('@deepseek-ai/'))).toBe(false)
  expect(pkg.dsh).toBeUndefined()
})
it('does not export fixed model defaults', () => {
  expect(entry).not.toHaveProperty('ROLE_MODELS')
})
it('retains machine limits and rejects obsolete setup fields before starting the application', () => {
  const machine = machineOf(Config({ stateDir: '/srv/superagent-state', promptMaxChars: 5000 }))
  expect(machine.promptMaxChars.get()).toBe(5000)
  expect(() => machineOf(Config({ stateDir: '/srv/superagent-state', github: { cli: 'gh' } }))).toThrow('github (now on the GitHub Source)')
})
