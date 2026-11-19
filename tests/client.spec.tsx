// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll } from '../src/client/api.ts'
import { mountStandalone, StandaloneApp } from '../src/client/index.tsx'
import { en, zh } from '../src/client/locales.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function serve(routes: {
  link?: (id: string, init?: RequestInit) => Promise<Response>
  deployment?: () => Promise<Response>
} = {}) {
  const seen: { path: string; method: string; headers: Record<string, string>; signal?: AbortSignal | null | undefined }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    seen.push({
      path,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal: init?.signal,
    })
    if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
    if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
      setup: { machine: { stateDir: '/srv/state', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
    if (path === 'deployment') return routes.deployment ? routes.deployment()
      : Response.json({ revision: 1, value: { stateDir: '/srv/state', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, writable: true })
    if (path.startsWith('sessions/') && path.endsWith('/link')) {
      const id = decodeURIComponent(path.slice('sessions/'.length, -'/link'.length))
      if (routes.link) return routes.link(id, init)
      return Response.json({ url: `paseo://h/server-1/agent/${id}` })
    }
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }))
  return seen
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function renderStandalone(openUrl = vi.fn()) {
  const container = document.createElement('div'); document.body.append(container)
  let handle: { unmount: () => void } | undefined
  await act(async () => { handle = mountStandalone(container, { openUrl }) })
  await flush()
  return { container, openUrl, dispose: () => { act(() => { handle?.unmount() }); container.remove() } }
}
const clickMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { button.click() })
  await flush()
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  delete document.documentElement.dataset.theme
  delete document.body.dataset.dsDarkTheme
})

it('mounts the standalone Superagent panel in Chinese by default with 6 tabs and toggles language and theme', async () => {
  serve()
  const view = await renderStandalone()
  expect(view.container.querySelector('.dt-title')?.textContent).toBe('Superagent')
  expect([...view.container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual([
    '概览', '来源', '触发', '评估', '执行', '设置',
  ])
  expect(document.documentElement.lang).toBe('zh-CN')
  await act(async () => {
    view.container.querySelector<HTMLButtonElement>(`button[aria-label="${zh.switchLang}"]`)!.click()
  })
  expect(document.documentElement.lang).toBe('en')
  expect([...view.container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual([
    en['tab.overview'], en['tab.source'], en['tab.trigger'], en['tab.eval'], en['tab.execution'], en['tab.settings'],
  ])
  const themeBtn = () => view.container.querySelector<HTMLButtonElement>(`button[aria-label^="${en.switchTheme.split('{')[0]}"]`)!
  await act(async () => { themeBtn().click() })
  expect(document.documentElement.dataset.theme).toBe('light')
  await act(async () => { themeBtn().click() })
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
  view.dispose()
})

it('opens a Paseo deep link resolved from /orchestrator/api/sessions/:id/link with x-orchestrator-request', async () => {
  const seen = serve()
  const view = await renderStandalone()
  await clickMaster(view.container)
  expect(view.openUrl).toHaveBeenCalledExactlyOnceWith('paseo://h/server-1/agent/master')
  const call = seen.find(item => item.path === 'sessions/master/link')
  expect(call).toMatchObject({ method: 'GET', headers: { 'x-orchestrator-request': '1' } })
  expect(call?.signal).toBeInstanceOf(AbortSignal)
  view.dispose()
})

it('rejects malformed or non-paseo links and reports missing or unreachable sessions in the interface language', async () => {
  for (const invalid of ['https://evil.example/hijack', 'paseo://local/agents/master', 'paseo:///agents/a1?view=log', 'paseo:garbage']) {
    serve({ link: async () => Response.json({ url: invalid }) })
    const view = await renderStandalone()
    await clickMaster(view.container)
    expect(view.openUrl).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(zh.sessionInvalidLink)
    view.dispose()
  }

  serve({ link: async () => Response.json({ error: 'Session not found' }, { status: 404 }) })
  let view = await renderStandalone()
  await clickMaster(view.container)
  expect(view.openUrl).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.sessionNotListed)
  view.dispose()

  serve({ link: async () => new Response(null, { status: 404 }) })
  view = await renderStandalone()
  await clickMaster(view.container)
  expect(view.openUrl).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.hostNotRunning)
  view.dispose()
})

it('ignores both late resolve and late reject of a superseded navigation after a newer request succeeds', async () => {
  const first = Promise.withResolvers<Response>()
  const second = Promise.withResolvers<Response>()
  let count = 0
  const signals: (AbortSignal | null | undefined)[] = []
  serve({
    link: async (_id, init) => {
      signals.push(init?.signal)
      return ++count === 1 ? first.promise : second.promise
    },
  })
  const openUrl = vi.fn()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<StandaloneApp openUrl={openUrl} />) })
  await flush()
  const btn = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { btn.click() })
  await act(async () => { btn.click() })
  expect(signals[0]?.aborted).toBe(true)
  expect(signals[1]?.aborted).toBe(false)
  second.resolve(Response.json({ url: 'paseo://h/server-1/agent/second' }))
  await flush()
  expect(openUrl).toHaveBeenCalledExactlyOnceWith('paseo://h/server-1/agent/second')
  first.reject(new Error('late network error'))
  await flush()
  expect(document.querySelector('.dt-toast')).toBeNull()
  expect(openUrl).toHaveBeenCalledExactlyOnceWith('paseo://h/server-1/agent/second')
  act(() => { root.unmount() }); container.remove()
})

it('ignores late reject after the panel unmounts without showing a toast', async () => {
  const first = Promise.withResolvers<Response>()
  const signals: (AbortSignal | null | undefined)[] = []
  serve({
    link: async (_id, init) => {
      signals.push(init?.signal)
      return first.promise
    },
  })
  const openUrl = vi.fn()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<StandaloneApp openUrl={openUrl} />) })
  await flush()
  const btn = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { btn.click() })
  expect(signals[0]?.aborted).toBe(false)
  act(() => { root.unmount() }); container.remove()
  expect(signals[0]?.aborted).toBe(true)
  first.reject(new DOMException('Aborted', 'AbortError'))
  await flush()
  expect(document.querySelector('.dt-toast')).toBeNull()
  expect(openUrl).not.toHaveBeenCalled()
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('tells a service that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // The host answers an empty 404 while routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})

it('serves web/index.html pointing at /assets/client.js without module loader hooks', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  expect(html).toContain('<div id="root"></div>')
  expect(html).toContain('<script type="module" src="/assets/client.js"></script>')
  expect(html).not.toContain('__ModuleLoader__')
})
