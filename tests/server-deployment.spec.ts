import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/server/config.ts'
import { DeploymentConflict, DeploymentReadOnly, DeploymentSettings } from '../src/server/deployment.ts'

const io = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: (...args: Parameters<typeof actual.rename>) => io.failRename
    ? Promise.reject(new Error('synthetic storage failure')) : actual.rename(...args) }
})

let root = ''
beforeAll(async () => { root = await fs.mkdtemp(join(tmpdir(), 'standalone-deployment-')) })
afterAll(async () => { if (root && process.platform === 'darwin') await promisify(execFile)('/usr/bin/trash', [root]) })
const stateDir = () => join(root, randomBytes(8).toString('hex'))

describe('standalone deployment settings', () => {
  it('persists only overrides with private permissions, updates live Machine values and restores defaults on unset', async () => {
    const config = loadConfig({ stateDir: stateDir(), promptMaxChars: 42_000, admissionContextMaxPages: 12 })
    const store = await DeploymentSettings.open(config), machine = store.machine
    expect(store.read()).toEqual({ revision: 0, writable: true, value: { stateDir: config.stateDir, promptMaxChars: 42_000,
      admissionContextMaxPages: 12, admissionContextTimeoutMs: 15_000, instanceId: null,
      listen: { host: '127.0.0.1', port: 3083 }, paseoEndpoint: '127.0.0.1:6767' } })
    const updated = await store.write([
      { op: 'set', path: ['promptMaxChars'], value: 55_000 },
      { op: 'set', path: ['admissionContextMaxPages'], value: 20 },
    ], 0)
    expect(updated.revision).toBe(1)
    expect(machine.promptMaxChars.get()).toBe(55_000)
    expect(machine.admissionContextMaxPages.get()).toBe(20)
    const path = join(config.stateDir, 'machine-settings.json')
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({ revision: 1,
      overrides: { promptMaxChars: 55_000, admissionContextMaxPages: 20 } })
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    const reopened = await DeploymentSettings.open(config)
    expect(reopened.read()).toEqual(updated)
    const reset = await reopened.write([{ op: 'unset', path: ['promptMaxChars'] }], 1)
    expect(reset.revision).toBe(2)
    expect(reopened.machine.promptMaxChars.get()).toBe(42_000)
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({ revision: 2, overrides: { admissionContextMaxPages: 20 } })
    expect((await DeploymentSettings.open(config)).read()).toEqual(reset)
  })

  it('serializes same-revision writes within one instance and across instances for the same directory', async () => {
    const config = loadConfig({ stateDir: stateDir() })
    const first = await DeploymentSettings.open(config), second = await DeploymentSettings.open(config)
    const results = await Promise.allSettled([
      first.write([{ op: 'set', path: ['promptMaxChars'], value: 40_000 }], 0),
      first.write([{ op: 'set', path: ['promptMaxChars'], value: 50_000 }], 0),
      second.write([{ op: 'set', path: ['promptMaxChars'], value: 60_000 }], 0),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected).toHaveLength(2)
    for (const result of rejected) expect(result.reason).toBeInstanceOf(DeploymentConflict)
    expect((await DeploymentSettings.open(config)).read().revision).toBe(1)
  })

  it('refuses read-only and invalid direct writes without changing the revision', async () => {
    const config = loadConfig({ stateDir: stateDir() })
    const readonly = await DeploymentSettings.open(config, { writable: false })
    await expect(readonly.write([{ op: 'set', path: ['promptMaxChars'], value: 50_000 }], 0)).rejects.toBeInstanceOf(DeploymentReadOnly)
    expect(readonly.read()).toMatchObject({ revision: 0, writable: false })
    const store = await DeploymentSettings.open(config)
    for (const request of [
      { revision: 0, ops: [{ op: 'set', path: ['stateDir'], value: '/another' }] },
      { revision: 0, ops: [{ op: 'set', path: ['promptMaxChars'], value: 999 }] },
      { revision: 0, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 2.5 }] },
      { revision: 0, ops: [{ op: 'unset', path: ['promptMaxChars'], value: 1 }] },
      { revision: 0, ops: [{ op: 'unset', path: ['promptMaxChars'] }, { op: 'unset', path: ['promptMaxChars'] }] },
      { revision: -1, ops: [{ op: 'unset', path: ['promptMaxChars'] }] },
    ]) await expect(store.write(request.ops as never, request.revision)).rejects.toThrow()
    expect(store.read().revision).toBe(0)
  })

  it.each(['{broken', JSON.stringify({ revision: 1, overrides: { promptMaxChars: 999 } }),
    JSON.stringify({ revision: 1, overrides: {}, unexpected: true })])('rejects a corrupt existing file without replacing it', async content => {
    const config = loadConfig({ stateDir: stateDir() }), path = join(config.stateDir, 'machine-settings.json')
    await fs.mkdir(config.stateDir, { recursive: true })
    await fs.writeFile(path, content)
    await expect(DeploymentSettings.open(config)).rejects.toThrow('Unable to open deployment settings')
    expect(await fs.readFile(path, 'utf8')).toBe(content)
  })

  it('leaves the old disk file and live revision intact if atomic replacement fails', async () => {
    const config = loadConfig({ stateDir: stateDir() }), store = await DeploymentSettings.open(config)
    await store.write([{ op: 'set', path: ['promptMaxChars'], value: 50_000 }], 0)
    const path = join(config.stateDir, 'machine-settings.json'), before = await fs.readFile(path, 'utf8')
    io.failRename = true
    try {
      await expect(store.write([{ op: 'set', path: ['promptMaxChars'], value: 60_000 }], 1)).rejects.toThrow('Unable to save deployment settings')
      expect(store.read().revision).toBe(1)
      expect(store.machine.promptMaxChars.get()).toBe(50_000)
      expect(await fs.readFile(path, 'utf8')).toBe(before)
    } finally { io.failRename = false }
    const retried = await store.write([{ op: 'set', path: ['promptMaxChars'], value: 60_000 }], 1)
    expect(retried.revision).toBe(2)
    expect(store.machine.promptMaxChars.get()).toBe(60_000)
  })
})
