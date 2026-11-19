// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { openSessionLink, parsePaseoLink, SessionNavigationError } from '../src/navigation.ts'
import { initialLocation, parseRoute, remember, setupPage } from '../src/client/route.ts'

it('accepts paseo://h/<serverId>/agent/<agentId> deep links and rejects non-canonical or unsafe links', () => {
  expect(parsePaseoLink('paseo://h/server-1/agent/agent-1')).toBe('paseo://h/server-1/agent/agent-1')
  expect(parsePaseoLink('  PASEO://h/srv_1/agent/a%3A1  ')).toBe('paseo://h/srv_1/agent/a%3A1')
  for (const bad of [
    '',
    '   ',
    'paseo:',
    'paseo://',
    'paseo://local/agents/master',
    'paseo:///agents/a1?view=log',
    'paseo:garbage',
    'paseo://h/server-1/agent/agent-1?view=log',
    'paseo://h/server-1/agent/agent-1#section',
    'paseo://h/server-1/agent/agent-1?',
    'paseo://h/server-1/agent/agent-1#',
    'paseo://user:pass@h/server-1/agent/agent-1',
    'paseo://user@h/server-1/agent/agent-1',
    'paseo://h:8080/server-1/agent/agent-1',
    'paseo://h/%20/agent/agent-1',
    'paseo://h/server-1/agent/%20',
    'paseo://h/server-1/other/agent-1',
    'paseo://h/server-1/agent',
    'paseo://h/server-1/agent/agent-1/extra',
    'paseo://h/server-1/agent/%E0%A4%A',
    'https://example.com/a',
    'http://127.0.0.1:3000',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    '/h/server-1/agent/agent-1',
    'not a url',
  ]) {
    expect(() => parsePaseoLink(bad), bad).toThrow(SessionNavigationError)
    try { parsePaseoLink(bad) } catch (error) { expect(error).toMatchObject({ code: 'invalid-link' }) }
  }
})

it('resolves a Paseo link and opens it after verifying the deep-link format', async () => {
  const resolve = vi.fn(async (id: string) => ({ url: `paseo://h/server-1/agent/${id}` }))
  const open = vi.fn()
  await expect(openSessionLink(resolve, 'agent-1', open, new AbortController().signal)).resolves.toBe(true)
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledExactlyOnceWith('paseo://h/server-1/agent/agent-1')
})

it('rejects non-canonical or non-paseo links from the backend without invoking the opener', async () => {
  for (const url of ['https://evil.example/phish', 'paseo://local/agents/master', 'paseo:///agents/a1?view=log', 'paseo:garbage']) {
    const resolve = vi.fn(async () => ({ url }))
    const open = vi.fn()
    await expect(openSessionLink(resolve, 'agent-1', open, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid-link' })
    expect(open).not.toHaveBeenCalled()
  }
})

it('silently ignores both late resolve and late reject after the request is aborted', async () => {
  const resolved = Promise.withResolvers<{ url: string }>()
  const open = vi.fn()
  const c1 = new AbortController()
  const nav1 = openSessionLink(async () => resolved.promise, 'agent-1', open, c1.signal)
  c1.abort()
  resolved.resolve({ url: 'paseo://h/server-1/agent/agent-1' })
  await expect(nav1).resolves.toBe(false)
  expect(open).not.toHaveBeenCalled()

  const rejected = Promise.withResolvers<{ url: string }>()
  const c2 = new AbortController()
  const nav2 = openSessionLink(async () => rejected.promise, 'agent-1', open, c2.signal)
  c2.abort()
  rejected.reject(new Error('late network failure'))
  await expect(nav2).resolves.toBe(false)
  expect(open).not.toHaveBeenCalled()
})

it('reopens the page this tab showed last, and the overview for a route that no longer exists', () => {
  remember({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  expect(initialLocation()).toEqual({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  // The Eval tab was previously named Policy; a route saved under the old name falls back to overview.
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'policy' }, stack: [] }))
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'trigger', id: 'github:1' }, stack: [{ page: 'policy' }, { page: 'trigger' }] }))
  expect(initialLocation().stack).toEqual([{ page: 'trigger' }])
  sessionStorage.setItem('dsh-superagent/route', '{')
  expect(initialLocation().route).toEqual({ page: 'overview' })
})

it('reads each page a tab remembered with the parameters it takes, and leaves out what it does not know', () => {
  expect(parseRoute({ page: 'trigger', query: { filter: 'nope', trigger: 'e1' } })).toEqual({ page: 'trigger' })
  expect(parseRoute({ page: 'trigger', id: 'github:1', query: { trigger: 'e1', filter: 'recent' } }))
    .toEqual({ page: 'trigger', id: 'github:1', query: { trigger: 'e1' } })
  expect(parseRoute({ page: 'eval', query: { filter: 'stop', window: '7d' } })).toEqual({ page: 'eval', query: { filter: 'stop' } })
  expect(parseRoute({ page: 'execution', id: 5, query: { filter: 'idle' } })).toEqual({ page: 'execution', query: { filter: 'idle' } })
  expect(parseRoute({ page: 'settings', query: { group: 'policy', source: 'feishu' } }))
    .toEqual({ page: 'settings', query: { group: 'source', source: 'feishu' } })
  expect([parseRoute('overview'), parseRoute(null)]).toEqual([undefined, undefined])
})

it('opens the settings that fix each setup problem: the Deployment group, or the card of the Source it names', () => {
  expect(setupPage('deployment')).toEqual({ page: 'settings', query: { group: 'deployment' } })
  for (const place of ['github', 'feishu'] as const) expect(setupPage(place)).toEqual({ page: 'settings', query: { group: 'source', source: place } })
})
