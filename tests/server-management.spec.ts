import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createManagementHandler, registerHttp, type HttpHost, type ManagementServices } from '../src/app/http.ts'
import { UserError } from '../src/core/index.ts'
import { loadConfig } from '../src/server/config.ts'
import { DeploymentSettings } from '../src/server/deployment.ts'
import { createStandaloneServer } from '../src/server/http.ts'

const password = randomBytes(32).toString('base64url')
const marker = 'synthetic-private-error-marker'
let root = '', server: Server | undefined
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'standalone-management-'))
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>test</title>')
})
afterEach(async () => {
  const current = server; server = undefined
  if (current?.listening) await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()))
})
afterAll(async () => { if (root && process.platform === 'darwin') await promisify(execFile)('/usr/bin/trash', [root]) })

async function fixture(options: { writable?: boolean } = {}) {
  const stateDir = join(root, randomBytes(8).toString('hex'))
  const config = loadConfig({ stateDir, instanceId: 'project-a', promptMaxChars: 42_000 })
  const deployment = await DeploymentSettings.open(config, options)
  const pause = vi.fn(async (value: boolean) => ({ paused: value }))
  const runtime = {
    ready: Promise.resolve(), machine: deployment.machine,
    store: { tickets: { get: () => undefined } },
    settings: { pause },
    sessions: { delivery: async () => 'injected' },
    engine: { unsubscribe: (key: string) => { if (key === 'refused') throw new UserError('sourceThread'); return true } },
    prompts: { preview: vi.fn() },
    models: () => { throw new Error(`disk full ${marker}`) },
  } as unknown as HttpHost
  const sessionLink = vi.fn((id: string) => id === 'worker-local-123'
    ? { serverId: 'srv_1', agentId: '12345678-1234-4234-8234-123456789abc' } : undefined)
  const services: ManagementServices = { deploymentSettings: deployment, sessionLink }
  const managementHandler = createManagementHandler(runtime, services)
  server = await createStandaloneServer({ config, password, staticRoot: join(root, 'web'), managementHandler })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  const port = address.port, origin = `http://127.0.0.1:${port}`
  config.port = port; config.publicOrigin = origin; config.allowedHosts = [`127.0.0.1:${port}`]
  async function send(path: string, input: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: input.method ?? 'GET', headers: input.headers }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      })
      req.on('error', reject)
      if (input.body !== undefined) req.write(input.body)
      req.end()
    })
  }
  const login = await send('/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password }) })
  expect(login.status).toBe(200)
  const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
  const api = (path: string, method = 'GET', body?: unknown) => send(`/orchestrator/api/${path}`, {
    method, headers: { cookie, origin, 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  return { config, deployment, runtime, services, managementHandler, sessionLink, pause, send, api, origin, cookie }
}

describe('management routes behind the standalone server', () => {
  it('requires login and serializes same-revision writes, updating Machine getters and the persisted revision', async () => {
    const f = await fixture()
    expect((await f.send('/orchestrator/api/deployment', { headers: { 'x-orchestrator-request': '1' } })).status).toBe(401)
    expect((await f.send('/orchestrator/api/deployment', { headers: { cookie: f.cookie } })).status).toBe(403)
    const initial = await f.api('deployment')
    expect(initial.status).toBe(200); expect(initial.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(initial.text)).toMatchObject({ revision: 0, writable: true, value: {
      promptMaxChars: 42_000, instanceId: 'project-a', stateDir: f.config.stateDir,
      listen: { host: f.config.host, port: f.config.port }, paseoEndpoint: '127.0.0.1:6767',
    } })
    const writes = await Promise.all([40_000, 50_000].map(value => f.api('deployment', 'PUT', {
      revision: 0, ops: [{ op: 'set', path: ['promptMaxChars'], value }],
    })))
    expect(writes.map(response => response.status).sort()).toEqual([200, 409])
    const success = JSON.parse(writes.find(response => response.status === 200)!.text)
    expect(success.revision).toBe(1)
    expect(f.deployment.machine.promptMaxChars.get()).toBe(success.value.promptMaxChars)
    expect((await DeploymentSettings.open(f.config)).read()).toEqual(success)
    const reset = await f.api('deployment', 'PUT', { revision: 1, ops: [{ op: 'unset', path: ['promptMaxChars'] }] })
    expect(reset.status).toBe(200)
    expect(f.deployment.machine.promptMaxChars.get()).toBe(42_000)
    expect((await DeploymentSettings.open(f.config)).read().revision).toBe(2)
  })

  it('rejects stateDir, unknown keys, invalid operations and out-of-range values before saving', async () => {
    const f = await fixture()
    for (const body of [
      { revision: 0, ops: [{ op: 'set', path: ['stateDir'], value: '/outside' }] },
      { revision: 0, ops: [{ op: 'unset', path: ['instanceId'] }] },
      { revision: 0, ops: [{ op: 'unset', path: ['listen'] }] },
      { revision: 0, ops: [{ op: 'unset', path: ['paseoEndpoint'] }] },
      { revision: 0, ops: [{ op: 'set', path: ['promptMaxChars'], value: 999 }] },
      { revision: 0, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 1.5 }] },
      { revision: 0, ops: [{ op: 'unset', path: ['promptMaxChars'], value: 1 }] },
      { revision: 0, ops: [{ op: 'unset', path: ['promptMaxChars'] }], [marker]: 'unexpected' },
    ]) {
      const response = await f.api('deployment', 'PUT', body)
      expect(response.status).toBe(400)
      expect(response.text).not.toContain(marker)
    }
    expect(f.deployment.read().revision).toBe(0)
  })

  it('returns an honest 403 when deployment settings are read-only', async () => {
    const f = await fixture({ writable: false })
    expect(JSON.parse((await f.api('deployment')).text).writable).toBe(false)
    const response = await f.api('deployment', 'PUT', { revision: 0, ops: [{ op: 'unset', path: ['promptMaxChars'] }] })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.text)).toEqual({ error: 'Deployment settings are read-only' })
    expect(f.deployment.read().revision).toBe(0)
  })

  it('accepts an allowed private Host without repeating the legacy loopback-only check', async () => {
    const f = await fixture(), port = new URL(f.origin).port, host = `10.1.2.3:${port}`
    f.config.allowedHosts.push(host)
    const response = await f.send('/orchestrator/api/deployment', { headers: { host, origin: `http://${host}`,
      cookie: f.cookie, 'x-orchestrator-request': '1' } })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text).value.stateDir).toBe(f.config.stateDir)
  })

  it('keeps the old DSH adapter read-only and does not invent session links', async () => {
    const f = await fixture()
    let legacy: ((req: unknown, res: unknown) => Promise<void>) | undefined
    const context = { webServer: { host: '127.0.0.1', port: 3082,
      register: (route: { handler: typeof legacy }) => { legacy = route.handler; return () => {} } } }
    registerHttp(context as never, f.runtime)
    async function call(method: string, path: string, body?: unknown) {
      let status = 0, text = ''
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
        async *[Symbol.asyncIterator]() { yield* chunks } }
      await legacy!(req, { writeHead: (code: number) => { status = code }, end: (value: string) => { text = value } })
      return { status, body: JSON.parse(text) as Record<string, unknown> }
    }
    expect(await call('GET', 'deployment')).toMatchObject({ status: 200, body: { revision: 0, writable: false,
      value: { stateDir: f.config.stateDir, promptMaxChars: 42_000 } } })
    expect(await call('PUT', 'deployment', { revision: 0, ops: [{ op: 'unset', path: ['promptMaxChars'] }] }))
      .toEqual({ status: 403, body: { error: 'Deployment settings are read-only' } })
    expect(await call('GET', 'sessions/worker-local-123/link')).toEqual({ status: 404, body: { error: 'Session not found' } })
    expect(f.deployment.read().revision).toBe(0)
  })

  it('looks up the bound real agent, returns a canonical link and reports missing sessions', async () => {
    const f = await fixture()
    const link = await f.api('sessions/worker-local-123/link')
    expect(link.status).toBe(200)
    expect(JSON.parse(link.text)).toEqual({ url: 'paseo://h/srv_1/agent/12345678-1234-4234-8234-123456789abc' })
    expect(f.sessionLink).toHaveBeenCalledWith('worker-local-123')
    const missing = await f.api('sessions/unknown/link')
    expect(missing.status).toBe(404); expect(JSON.parse(missing.text)).toEqual({ error: 'Session not found' })
  })

  it('keeps existing route results and known errors, while hiding unexpected errors', async () => {
    const f = await fixture()
    const pause = await f.api('executor/pause', 'POST', { paused: true })
    expect(pause.status).toBe(200); expect(JSON.parse(pause.text)).toEqual({ paused: true })
    expect(f.pause).toHaveBeenCalledWith(true, 'panel')
    const thread = await f.api(`threads/${encodeURIComponent('source:channel/root')}/unsubscribe`, 'POST')
    expect(JSON.parse(thread.text)).toEqual({ removed: true, thread: 'source:channel/root', context_delivery: 'injected' })
    const refused = await f.api('threads/refused/unsubscribe', 'POST')
    expect(refused.status).toBe(400)
    expect(JSON.parse(refused.text)).toMatchObject({ code: 'sourceThread', error: expect.any(String), values: {} })
    const missing = await f.api('tickets/missing/retry', 'POST')
    expect(missing.status).toBe(404); expect(JSON.parse(missing.text)).toEqual({ error: 'Ticket not found' })
    const failed = await f.api('models')
    expect(failed.status).toBe(500); expect(JSON.parse(failed.text)).toEqual({ error: 'Internal server error' })
    expect(failed.text).not.toContain('disk full'); expect(failed.text).not.toContain(marker)
  })

  it('rejects oversized and malformed bodies and paths without leaking input', async () => {
    const f = await fixture()
    const large = await f.api('deployment', 'PUT', JSON.stringify({ revision: 0, ops: [], padding: 'x'.repeat(128 * 1024) }))
    expect(large.status).toBe(400)
    expect(JSON.parse(large.text)).toEqual({ error: 'Request exceeds 131072 bytes' })
    expect((await f.api('deployment', 'PUT', '{broken')).status).toBe(400)
    expect((await f.api('deployment', 'PUT', { revision: 0, ops: [{ op: 'set', path: ['promptMaxChars'], value: 1000 }] })).status).toBe(200)
    const longPrompt = await f.api('prompts', 'PUT', JSON.stringify({ baseRevision: 0, config: { communication: 'x'.repeat(9000) } }))
    expect(longPrompt.status).toBe(400)
    expect(JSON.parse(longPrompt.text)).toEqual({ error: 'Request exceeds 8096 bytes' })
    const malformed = await f.api('sessions/%ZZ/link')
    expect(malformed.status).toBe(404)
    const response = { status: 0, text: '' }
    const handled = await f.managementHandler({ url: '/orchestrator/api/sessions/%ZZ/link', method: 'GET' } as IncomingMessage,
      { writeHead: (status: number) => { response.status = status }, end: (text: string) => { response.text = text } } as unknown as ServerResponse)
    expect(handled).toBe(true); expect(response.status).toBe(400)
    expect(JSON.parse(response.text)).toEqual({ error: 'A path segment has a malformed escape' })
    expect(await f.managementHandler({ url: '/orchestrator/api/unknown', method: 'GET' } as IncomingMessage, {} as ServerResponse)).toBe(false)
    expect((await f.api('unknown')).status).toBe(404)
  })
})
