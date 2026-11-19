import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startApplication } from '../src/server/application.ts'
import { loadConfig } from '../src/server/config.ts'
import { createStandaloneServer } from '../src/server/http.ts'
import * as deployment from '../src/deployment.ts'
import { Store } from '../src/app/store.ts'
import { acquireStateLock } from '../src/runtime/lock.ts'
import * as github from '../src/sources/github.ts'
import * as gitlab from '../src/sources/gitlab.ts'
import * as feishu from '../src/sources/feishu.ts'
import * as dingtalk from '../src/sources/dingtalk.ts'
import * as paseo from '../src/sources/paseo.ts'
import { deferred, track } from './fixtures/async.ts'
import { assessorProfile, executorProfile, TestDaemon } from './fixtures/paseo-runtime.ts'
import { testDeployment } from './fixtures/deployment.ts'

const password = randomBytes(32).toString('base64url')
let root = ''
const servers = new Set<Server>()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'standalone-http-'))
  await mkdir(join(root, 'web', 'assets'), { recursive: true })
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>test</title>')
  await writeFile(join(root, 'web', 'assets', 'client.js'), 'console.log("test")')
  await writeFile(join(root, 'web', 'config.txt'), 'inside static root, outside assets')
  await writeFile(join(root, 'private.txt'), 'outside static root')
  await symlink(join(root, 'private.txt'), join(root, 'web', 'assets', 'escape.js'))
  await symlink(join(root, 'web', 'config.txt'), join(root, 'web', 'assets', 'local-link.js'))
})

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  servers.add(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  return address.port
}
async function close(server: Server): Promise<void> {
  servers.delete(server)
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
afterEach(async () => {
  await Promise.all([...servers].map(close))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(async () => {
  if (root && process.platform === 'darwin') await promisify(execFile)('/usr/bin/trash', [root])
})

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
function sendTo(port: number, path: string, input: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: input.method ?? 'GET', headers: input.headers }, res => {
      const parts: Buffer[] = []
      res.on('data', chunk => parts.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(input.body)
  })
}
async function fixture(options: { sessionTtlMs?: number; now?: () => number; password?: string; secure?: boolean; state?: string } = {}) {
  const config = loadConfig({ stateDir: join(root, options.state ?? 'state'), ...(options.secure ? { publicOrigin: 'https://127.0.0.1:3083' } : {}) })
  const handler = vi.fn(async (req, res) => {
    if (req.url === '/orchestrator/api/explode') throw new Error(`sensitive: ${password}`)
    if (req.url !== '/orchestrator/api/test') return false
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return true
  })
  const server = await createStandaloneServer({ config, password: options.password ?? password, staticRoot: join(root, 'web'),
    managementHandler: handler, sessionTtlMs: options.sessionTtlMs, now: options.now })
  const port = await listen(server), origin = `${options.secure ? 'https' : 'http'}://127.0.0.1:${port}`
  // Port zero is for the test listener only; production config always has a valid explicit port.
  config.port = port; config.publicOrigin = origin; config.allowedHosts = [`127.0.0.1:${port}`]
  const send = (path: string, input?: Parameters<typeof sendTo>[2]) => sendTo(port, path, input)
  async function login(cookie = ''): Promise<string> {
    const response = await send('/login', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password }) })
    expect(response.status).toBe(200)
    return response.headers['set-cookie']![0]!.split(';')[0]!
  }
  return { server, port, origin, send, login, handler }
}

describe('standalone HTTP server', () => {
  it('fails closed when no password is configured', async () => {
    const config = loadConfig({ stateDir: join(root, 'state') })
    await expect(createStandaloneServer({ config, password: '', staticRoot: join(root, 'web'), managementHandler: () => true }))
      .rejects.toThrow(/^Invalid standalone authentication configuration$/)
  })

  it('requires login, performs password login and protects the management handler', async () => {
    const f = await fixture()
    const page = await f.send('/')
    expect(page.status).toBe(303); expect(page.headers.location).toBe('/login')
    const loginPage = await f.send('/login')
    expect(loginPage.status).toBe(200); expect(loginPage.headers['content-type']).toContain('text/html')
    expect(loginPage.headers['referrer-policy']).toBe('same-origin')
    expect(loginPage.headers['content-security-policy']).toContain("form-action 'self'")
    expect((await f.send('/healthz')).body).toBe('{"ok":true}')
    expect((await f.send('/orchestrator/api/test', { headers: { 'x-orchestrator-request': '1' } })).status).toBe(401)
    const wrong = await f.send('/login', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }) })
    expect(wrong.status).toBe(401); expect(wrong.body).toBe('{"error":"Invalid credentials"}')
    expect((await f.send('/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }) })).status).toBe(403)
    expect(f.handler).not.toHaveBeenCalled()
    const signedIn = await f.send('/login', { method: 'POST', headers: { origin: f.origin, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() })
    expect(signedIn.status).toBe(303); expect(signedIn.headers.location).toBe('/')
    const setCookie = signedIn.headers['set-cookie']![0]!
    expect(setCookie).toContain('HttpOnly; SameSite=Strict'); expect(setCookie).not.toContain('; Secure')
    const cookie = setCookie.split(';')[0]!
    const dashboard = await f.send('/', { headers: { cookie } })
    expect(dashboard.status).toBe(200); expect(dashboard.headers['referrer-policy']).toBe('same-origin')
    expect((await f.send('/orchestrator/api/test', { headers: { cookie } })).status).toBe(403)
    const api = await f.send('/orchestrator/api/test', { method: 'POST', headers: { cookie, origin: f.origin,
      'sec-fetch-site': 'same-origin', 'x-orchestrator-request': '1' } })
    expect(api.status).toBe(200); expect(api.headers['cache-control']).toBe('no-store')
    expect(f.handler).toHaveBeenCalledOnce()
    const unknown = await f.send('/orchestrator/api/unknown', { headers: { cookie, 'x-orchestrator-request': '1' } })
    expect(unknown.status).toBe(404); expect(unknown.headers['content-type']).toContain('application/json')
  })

  it('checks Host, Origin and Sec-Fetch-Site before login, logout and management writes', async () => {
    const f = await fixture(), cookie = await f.login()
    for (const origin of ['null', 'http://attacker.example']) {
      const rejected = await f.send('/login', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() })
      expect(rejected.status).toBe(403); expect(rejected.headers['set-cookie']).toBeUndefined()
    }
    const bad: Record<string, string>[] = [
      { host: 'attacker.example', 'x-forwarded-host': `127.0.0.1:${f.port}` },
      { origin: 'http://attacker.example' },
      { origin: `https://127.0.0.1:${f.port}`, 'x-forwarded-proto': 'https' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]
    for (const headers of bad) {
      expect((await f.send('/login', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ password }) })).status).toBe(403)
      expect((await f.send('/orchestrator/api/test', { method: 'POST', headers: { ...headers, cookie,
        'x-orchestrator-request': '1' } })).status).toBe(403)
      expect((await f.send('/logout', { method: 'POST', headers: { ...headers, cookie } })).status).toBe(403)
    }
    expect(f.handler).not.toHaveBeenCalled()
    expect((await f.send('/orchestrator/api/test', { headers: { cookie, 'x-orchestrator-request': '1',
      'x-forwarded-host': 'attacker.example' } })).status).toBe(200)
    const logout = await f.send('/logout', { method: 'POST', headers: { cookie, origin: f.origin } })
    expect(logout.status).toBe(303); expect(logout.headers['set-cookie']![0]).toContain('Max-Age=0')
    expect((await f.send('/orchestrator/api/test', { headers: { cookie, 'x-orchestrator-request': '1' } })).status).toBe(401)
  })

  it('expires sessions on the server even if a client retains the cookie', async () => {
    let now = 1000
    const f = await fixture({ sessionTtlMs: 1000, now: () => now }), cookie = await f.login()
    now = 2000
    expect((await f.send('/orchestrator/api/test', { headers: { cookie, 'x-orchestrator-request': '1' } })).status).toBe(401)
  })

  it('keeps both same-host panels signed in when one logs in again or signs out', async () => {
    const first = await fixture({ state: 'project-a' }), second = await fixture({ state: 'project-b' })
    expect(first.port).not.toBe(second.port)
    const a = await first.login(), b = await second.login(a)
    expect(a.split('=')[0]).not.toBe(b.split('=')[0])
    const cookie = `${a}; ${b}`
    const request = (f: typeof first, cookie: string) =>
      f.send('/orchestrator/api/test', { headers: { cookie, 'x-orchestrator-request': '1' } })
    expect((await request(first, cookie)).status).toBe(200)
    expect((await request(second, cookie)).status).toBe(200)
    const updated = `${await first.login(cookie)}; ${b}`
    const logout = await first.send('/logout', { method: 'POST', headers: { cookie: updated, origin: first.origin } })
    expect(logout.headers['set-cookie']![0]).toMatch(new RegExp(`^${a.split('=')[0]}=;`))
    expect((await request(first, updated)).status).toBe(401)
    expect((await request(second, updated)).status).toBe(200)
  })

  it('uses Secure cookies when the configured public origin is HTTPS', async () => {
    const f = await fixture({ secure: true })
    const response = await f.send('/login', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password }) })
    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']![0]).toContain('; Secure')
  })

  it('serves only authenticated static files, with MIME types, and rejects traversal and outside symlinks', async () => {
    const f = await fixture()
    expect((await f.send('/assets/client.js')).status).toBe(401)
    const cookie = await f.login(), headers = { cookie }
    const html = await f.send('/', { headers })
    expect(html.status).toBe(200); expect(html.headers['content-type']).toContain('text/html')
    const js = await f.send('/assets/client.js', { headers })
    expect(js.status).toBe(200); expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.headers['cache-control']).toBe('no-cache')
    for (const path of ['/assets/%2e%2e/private.txt', '/assets/%2e%2e%2fprivate.txt', '/assets/escape.js', '/assets/local-link.js', '/private.txt', '/assets/%00']) {
      const response = await f.send(path, { headers })
      expect(response.status).toBe(404); expect(response.body).not.toContain('outside static root')
    }
  })

  it('limits login bodies and never sends handler exceptions to the client', async () => {
    const f = await fixture()
    const tooLarge = await f.send('/login', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: 'x'.repeat(8193) })
    expect(tooLarge.status).toBe(413)
    const cookie = await f.login()
    const failed = await f.send('/orchestrator/api/explode', { headers: { cookie, 'x-orchestrator-request': '1' } })
    expect(failed.status).toBe(500); expect(failed.body).toBe('{"error":"Internal server error"}')
    expect(failed.body).not.toContain(password)
  })

  it('releases the listener when closed', async () => {
    const f = await fixture()
    await close(f.server)
    expect(await listen(createServer(), f.port)).toBe(f.port)
  })
})

describe('standalone startup', () => {
  async function unusedPort() {
    const reservation = createServer()
    const port = await listen(reservation)
    await close(reservation)
    return port
  }
  const opts = (daemon: TestDaemon) => ({ password, staticRoot: join(root, 'web'), paseo: { client: daemon.client } })
  async function loginForManagement(port: number) {
    const origin = `http://127.0.0.1:${port}`
    const response = await sendTo(port, '/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    expect(response.status).toBe(200)
    const cookie = response.headers['set-cookie']![0]!.split(';')[0]!
    return (path: string, value?: unknown) => sendTo(port, '/orchestrator/api/' + path, { method: value ? 'PUT' : 'GET',
      headers: { origin, cookie, 'content-type': 'application/json', 'x-orchestrator-request': '1' }, ...(value ? { body: JSON.stringify(value) } : {}) })
  }

  it('fails a second instance on the same port before connecting to Paseo or mounting sources', async () => {
    vi.stubEnv('PASEO_PASSWORD', undefined)
    vi.stubEnv('PASEO_PASSWORD_FILE', undefined)
    const mounts = [github, gitlab, feishu, dingtalk, paseo].map(source => vi.spyOn(source, 'apply').mockImplementation(() => {}))
    const port = await unusedPort(), stateDir = join(root, 'second')
    const first = await startApplication({ stateDir: join(root, 'first'), port }, opts(new TestDaemon()))
    try {
      for (const mount of mounts) expect(mount).toHaveBeenCalledOnce()
      const daemon = new TestDaemon(), connect = vi.spyOn(daemon.client, 'connect')
      await expect(startApplication({ stateDir, port }, opts(daemon))).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(connect).not.toHaveBeenCalled()
      for (const mount of mounts) expect(mount).toHaveBeenCalledOnce()
      acquireStateLock(stateDir, () => {}).release()
    } finally { await first.stop() }
  })

  it('returns 503 during initialization and closes the listener and lease on mount failure', async () => {
    vi.stubEnv('PASEO_PASSWORD', undefined)
    vi.stubEnv('PASEO_PASSWORD_FILE', undefined)
    const port = await unusedPort(), stateDir = join(root, 'failed')
    const daemon = new TestDaemon(), initializing = deferred()
    const connect = vi.spyOn(daemon.client, 'connect').mockReturnValueOnce(initializing.promise)
    const starting = startApplication({ stateDir, port }, opts(daemon))
    const failed = expect(starting).rejects.toThrow('Paseo connection failed')
    try {
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
      expect((await sendTo(port, '/orchestrator/api/deployment')).status).toBe(503)
    } finally {
      initializing.reject(new Error('Paseo connection failed'))
      await failed
    }
    acquireStateLock(stateDir, () => {}).release()
    expect(await listen(createServer(), port)).toBe(port)
  })

  it.each(['unmount', 'mount'] as const)('finishes shutdown before releasing the state lease during reload %s', async phase => {
    vi.stubEnv('PASEO_PASSWORD', undefined)
    vi.stubEnv('PASEO_PASSWORD_FILE', undefined)
    for (const source of [github, gitlab, feishu, dingtalk, paseo]) vi.spyOn(source, 'apply').mockImplementation(() => {})
    const port = await unusedPort(), stateDir = join(root, `stop-during-${phase}`)
    const daemon = new TestDaemon(), initialConnect = daemon.client.connect
    const connect = vi.spyOn(daemon.client, 'connect'), disconnect = vi.spyOn(daemon.client, 'close')
    const reloading = deferred(), continueReload = deferred()
    const holdReload = () => { reloading.resolve(); return continueReload.promise }
    if (phase === 'unmount') disconnect.mockImplementationOnce(holdReload)
    else connect.mockImplementationOnce(initialConnect).mockImplementationOnce(holdReload)

    const app = await startApplication({ stateDir, port }, opts(daemon))
    const previous = app.runtime
    try {
      const api = await loginForManagement(port)
      const save = await api('settings/eval', { revision: 0, value: { model: assessorProfile } })
      expect(save.status).toBe(200)
      expect(JSON.parse(save.body)).toMatchObject({ restarting: true })
      await reloading.promise

      const listenerClosed = once(app.server, 'close')
      const stopped = track(app.stop())
      expect(app.stop()).toBe(stopped.promise)
      await listenerClosed
      expect(stopped.settled).toBe(false)
      expect(() => acquireStateLock(stateDir, () => {}).release()).toThrow(expect.objectContaining({ code: 'ELOCKED' }))

      continueReload.resolve()
      await stopped.promise
      expect(app.runtime).toBe(previous)
      expect(previous.lifetime.aborted).toBe(true)
      const adapterCount = phase === 'unmount' ? 1 : 2
      expect(connect).toHaveBeenCalledTimes(adapterCount)
      expect(disconnect).toHaveBeenCalledTimes(adapterCount)
      acquireStateLock(stateDir, () => {}).release()
      expect(await listen(createServer(), port)).toBe(port)
    } finally {
      continueReload.resolve()
      await app.stop()
    }
  })

  it('serves the panel while Profiles are unset and starts automatically after both authenticated saves', async () => {
    vi.stubEnv('PASEO_PASSWORD', undefined)
    vi.stubEnv('PASEO_PASSWORD_FILE', undefined)
    const port = await unusedPort(), stateDir = join(root, 'profile-setup'), origin = `http://127.0.0.1:${port}`
    vi.spyOn(deployment, 'resolveDeployment').mockResolvedValue(testDeployment({ stateDir, feishu: undefined }))
    const daemon = new TestDaemon()
    const app = await startApplication({ stateDir, port, paseo: { worker: { profileId: 'invalid-seed' } } }, opts(daemon))
    try {
      expect(app.runtime.health.runtime).toMatchObject({ code: 'setupPending' })
      expect(app.runtime.setupProblem).toMatchObject({ code: 'evalProfileUnset' })
      expect(daemon.creates).toHaveLength(0)
      const login = await sendTo(port, '/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
      expect(login.status).toBe(200)
      const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
      const api = (path: string, value?: unknown) => sendTo(port, '/orchestrator/api/' + path, { method: value ? 'PUT' : 'GET',
        headers: { origin, cookie, 'content-type': 'application/json', 'x-orchestrator-request': '1' }, ...(value ? { body: JSON.stringify(value) } : {}) })
      const catalog = await api('models')
      expect(catalog.status).toBe(200)
      expect(JSON.parse(catalog.body).profiles).toMatchObject([{ ...assessorProfile, available: true }, { ...executorProfile, available: true }])
      const first = app.runtime
      const evaluation = await api('settings/eval', { revision: 0, value: { model: { ...assessorProfile, provider: 'forged-provider' } } })
      expect(evaluation.status).toBe(200)
      expect(JSON.parse(evaluation.body)).toMatchObject({ restarting: true })
      await vi.waitFor(async () => {
        expect(app.runtime).not.toBe(first)
        expect(app.runtime.setupProblem).toMatchObject({ code: 'executorProfileUnset' })
        expect((await api('models')).status).toBe(200)
      })
      expect(app.runtime.store.settings().eval.model).toEqual(assessorProfile)
      expect(daemon.creates).toHaveLength(0)
      const execution = await api('settings/executor', { revision: 0, value: { model: executorProfile } })
      expect(execution.status).toBe(200)
      await vi.waitFor(() => expect(app.runtime.health.runtime).toMatchObject({ state: 'ready' }))
      expect(app.runtime.store.settings().executor.model).toEqual(executorProfile)
      expect(daemon.creates).toMatchObject([{ provider: assessorProfile.provider, model: assessorProfile.model }])
    } finally { await app.stop() }
    const persisted = new Store(join(stateDir, 'orchestrator.sqlite'))
    try { expect(persisted.settings()).toMatchObject({ eval: { model: assessorProfile }, executor: { model: executorProfile } }) }
    finally { persisted.close() }
  })

  it('stores available profile seeds on startup and keeps the saved instance choice on reopen', async () => {
    vi.stubEnv('PASEO_PASSWORD', undefined)
    vi.stubEnv('PASEO_PASSWORD_FILE', undefined)
    const stateDir = join(root, 'profile-seeds'), daemon = new TestDaemon(), port = await unusedPort()
    vi.spyOn(deployment, 'resolveDeployment').mockResolvedValue(testDeployment({ stateDir, feishu: undefined }))
    const start = (main: string, worker: string) => startApplication({ stateDir, port, paseo: { main: { profileId: main }, worker: { profileId: worker } } }, opts(daemon))
    const first = await start(assessorProfile.profileId, executorProfile.profileId)
    try {
      expect(first.runtime.health.runtime).toMatchObject({ state: 'ready' })
      expect(first.runtime.store.settings()).toMatchObject({ eval: { model: assessorProfile }, executor: { model: executorProfile } })
    } finally { await first.stop() }
    const second = await start(executorProfile.profileId, assessorProfile.profileId)
    try {
      expect(second.runtime.health.runtime).toMatchObject({ state: 'ready' })
      expect(second.runtime.store.settings()).toMatchObject({ eval: { model: assessorProfile }, executor: { model: executorProfile } })
      expect(daemon.creates).toHaveLength(1)
    } finally { await second.stop() }
  })

  it('keeps the management API available after a failed main Profile at activation and restart, and recovers on save', async () => {
    vi.stubEnv('PASEO_PASSWORD', undefined)
    vi.stubEnv('PASEO_PASSWORD_FILE', undefined)
    const port = await unusedPort(), stateDir = join(root, 'failed-main-profile')
    vi.spyOn(deployment, 'resolveDeployment').mockResolvedValue(testDeployment({ stateDir, feishu: undefined }))
    const daemon = new TestDaemon(), create = daemon.client.createAgent, rejectedIds: string[] = []
    const diagnostic = 'Injected daemon rejection for the Pi model'
    vi.spyOn(daemon.client, 'createAgent').mockImplementation(input => {
      if (input.provider !== assessorProfile.provider) return create(input)
      rejectedIds.push(input.agentId!)
      return Promise.reject(new Error(diagnostic))
    })
    const start = () => startApplication({ stateDir, port, paseo: { worker: { profileId: executorProfile.profileId } } }, opts(daemon))
    const expectFailedProfile = async (api: Awaited<ReturnType<typeof loginForManagement>>) => {
      const state = await api('state')
      expect(state.status).toBe(200)
      expect(JSON.parse(state.body).health.runtime).toMatchObject({ state: 'error', detail: expect.stringContaining(assessorProfile.name) })
      expect(state.body).not.toContain(diagnostic)
      const overview = await api('overview')
      expect(overview.status).toBe(200)
      expect(JSON.parse(overview.body).problems).toContainEqual({
        kind: 'runtime-error', name: 'runtime', detail: expect.stringContaining(assessorProfile.name),
      })
      const models = await api('models')
      expect(models.status).toBe(200)
      expect(JSON.parse(models.body).profiles).toContainEqual({ ...executorProfile, available: true })
    }

    const first = await start()
    try {
      expect(first.runtime.setupProblem?.code).toBe('evalProfileUnset')
      const api = await loginForManagement(port)
      expect((await api('settings/eval', { revision: 0, value: { model: assessorProfile } })).status).toBe(200)
      await vi.waitFor(() => expectFailedProfile(api))
      expect(first.adapter.binding(first.runtime.masterId)).toMatchObject({ createdRemote: false, profile: assessorProfile })
      expect(rejectedIds).toHaveLength(1)
    } finally { await first.stop() }

    const second = await start()
    try {
      const api = await loginForManagement(port)
      await expectFailedProfile(api)
      expect(rejectedIds).toEqual([rejectedIds[0], rejectedIds[0]])
      const before = second.runtime
      const settings = await api('settings')
      expect(settings.status).toBe(200)
      const { revision, value } = JSON.parse(settings.body).blocks.eval
      expect((await api('settings/eval', { revision, value: { ...value, model: executorProfile } })).status).toBe(200)
      await vi.waitFor(async () => {
        const state = await api('state')
        expect(state.status).toBe(200)
        expect(JSON.parse(state.body).health.runtime).toMatchObject({ state: 'ready' })
      })
      expect(second.runtime).toBe(before)
      expect(second.adapter.binding(second.runtime.masterId)).toMatchObject({ createdRemote: true, profile: executorProfile })
      expect(daemon.creates).toHaveLength(1)
    } finally { await second.stop() }
  })

  it('recovers an unavailable persisted main session after an explicit Profile change', async () => {
    vi.stubEnv('PASEO_PASSWORD', undefined)
    vi.stubEnv('PASEO_PASSWORD_FILE', undefined)
    const stateDir = join(root, 'unavailable-main'), daemon = new TestDaemon(), port = await unusedPort()
    vi.spyOn(deployment, 'resolveDeployment').mockResolvedValue(testDeployment({ stateDir, feishu: undefined }))
    const start = () => startApplication({ stateDir, port, paseo: { main: { profileId: assessorProfile.profileId },
      worker: { profileId: executorProfile.profileId } } }, opts(daemon))
    const first = await start()
    const original = first.adapter.binding(first.runtime.masterId)
    await first.stop()

    const fetchAgent = daemon.client.fetchAgent
    const refuseOld = vi.spyOn(daemon.client, 'fetchAgent').mockImplementation((...args) =>
      args[0] === original.agentId ? Promise.reject(new Error('Injected restore failure')) : fetchAgent(...args))
    const second = await start()
    try {
      const api = await loginForManagement(port)
      const state = await api('state')
      expect(state.status).toBe(200)
      expect(JSON.parse(state.body).health.runtime).toMatchObject({ state: 'error', detail: expect.stringContaining('restore the main session') })
      expect(daemon.creates).toHaveLength(1)
      const { revision, value } = JSON.parse((await api('settings')).body).blocks.eval
      expect((await api('settings/eval', { revision, value: { ...value, model: executorProfile } })).status).toBe(200)
      await vi.waitFor(() => expect(second.runtime.health.runtime?.state).toBe('ready'))
      expect(second.adapter.binding(original.id)).toMatchObject({ createdRemote: true, profile: executorProfile })
      expect(daemon.creates).toHaveLength(2)
      expect(daemon.archived).toEqual([])
      refuseOld.mockRestore()
      await second.adapter.reconcile()
      expect(daemon.archived).toEqual([original.agentId])
    } finally { await second.stop() }
  })
})
