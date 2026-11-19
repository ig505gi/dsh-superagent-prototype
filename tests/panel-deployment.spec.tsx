// @vitest-environment jsdom
// The Deployment settings, standalone HTTP deployment adapter, and standalone deployment page.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { StandaloneDeployment } from '../src/client/deployment.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, mountApp, remount, settle, all, find, tab, click, type, text, field, at, translator } from './fixtures/panel.tsx'
import { server, problemOf, fakeForm } from './fixtures/panel-server.ts'

usePanel()
it('shows read-only instance details and names the panel tab', async () => {
  const { form, publish } = fakeForm()
  publish({ value: { ...form.getSnapshot().value, instanceId: 'project-a', listen: { host: '::1', port: 3083 },
    paseoEndpoint: '127.0.0.1:6767' } })
  server.form = form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(document.querySelector('.dt-head-title')?.textContent).toContain('project-a')
  expect(document.title).toBe('Superagent · project-a')
  const displayed = [zh.deploymentInstance, 'project-a', zh.deploymentListen, '[::1]:3083',
    zh.deploymentPaseoEndpoint, '127.0.0.1:6767', '/srv/dsh-superagent']
  for (const value of displayed) expect(document.querySelector('main')?.textContent).toContain(value)
  expect(all('input').some(input => displayed.includes((input as HTMLInputElement).value))).toBe(false)
})

it('saves machine limits in the Deployment settings without a restart', async () => {
  const { form: editable, mutations } = fakeForm()
  server.form = editable
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('/srv/dsh-superagent')
  // Accounts are on the Source settings; the Plugin Manager page, where those are not at hand, shows them here.
  expect(text()).not.toContain('@agent-bot')
  for (const moved of ['仓库克隆', '工单 worktree 目录', '禁用的命令']) expect(text()).not.toContain(moved)
  expect(text()).toContain(zh.deploymentIntro)
  // A limit applies at once, so a draft of one says only that it is unsaved, even while Assignments run.
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '20000')
  expect(document.querySelector('.dt-savebar')?.textContent).toBe(`${zh.draftKept}${zh.discard}${zh.save}`)
  await click(zh.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 20000 }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.saved)
  expect(text()).not.toContain(zh.savedRestarting)
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('20000')
})

it('keeps a refused Deployment change as a draft, and shows the settings read-only without a writable form', async () => {
  const refusing = fakeForm(true, false)
  server.form = refusing.form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '200000')
  await click(zh.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.deploymentRefused)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  server.form = fakeForm(false).form
  await remount()
  expect(text()).toContain(zh.deploymentReadOnly)
  server.form = undefined
  await remount()
  expect(text()).toContain(zh.deploymentNoForms)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(all('button').some(button => button.textContent === '保存')).toBe(false)
})

it('merges a Deployment draft into the values another page saved meanwhile, and writes only what it changed', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '20')
  // The Plugin Manager page saves another field of the same entry meanwhile.
  await act(async () => { await shared.mutate([{ op: 'set', path: ['promptMaxChars'], value: 50000 }], 1) })
  expect(text()).toContain('设置已在别处修改，你的修改已合并到最新版本')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('50000')
  await click(zh.save)
  expect(mutations.at(-1)).toEqual({ revision: 2, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 20 }] })
  expect(shared.getSnapshot().value).toMatchObject({ admissionContextMaxPages: 20, promptMaxChars: 50000 })
})

it('renders the standalone Deployment page with derived accounts, setup problems, editable limits, and host-down notice', async () => {
  let container = document.createElement('div')
  let root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const render = async () => {
    act(() => { root.unmount() }); container.remove()
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    const form = server.form
    await act(async () => { root.render(<StandaloneDeployment t={translator(zh)} form={form && { state: form.getSnapshot(),
      mutate: form.mutate }} />) })
    await settle()
  }
  server.form = fakeForm().form
  await render()
  for (const fact of ['acme/widgets', '@agent-bot', 'Widgets Bot', zh.deploymentAccountsWhere]) expect(text()).toContain(fact)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await render()
  expect(text()).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(false)
  server.down = true
  await render()
  expect(text()).toContain(zh.hostNotRunning)
})

it('shows unavailable or read-only status when deployment configuration cannot be edited', async () => {
  const { form: shared, publish } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  const limit = () => field<HTMLInputElement>(zh.deploymentPromptMaxChars)
  expect(limit().disabled).toBe(false)
  // While the backend restarts, its form is unavailable; the values come back editable once it is ready again.
  await act(async () => { publish({ status: 'unavailable' }) })
  expect(text()).toContain(zh.deploymentUnavailable)
  expect(limit().disabled).toBe(true)
  await act(async () => { publish({ status: 'ready' }) })
  expect(limit().disabled).toBe(false)
  await act(async () => { publish({ status: 'ready', writable: false }) })
  expect(text()).toContain(zh.deploymentReadOnly)
  expect(limit().disabled).toBe(true)
})

it('reads the state every second after a setup check, until dsh-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})

it('loads and updates machine limits via GET/PUT /orchestrator/api/deployment and keeps stateDir read-only', async () => {
  at({ page: 'settings', query: { group: 'deployment' } })
  await mountApp({ openUrl: vi.fn() })
  const getIndex = server.requests.findIndex(request => request.path === 'deployment' && request.method === 'GET')
  expect(getIndex).toBeGreaterThanOrEqual(0)
  expect(server.headers[getIndex]).toMatchObject({ 'x-orchestrator-request': '1' })
  expect(text()).toContain('/srv/dsh-superagent')
  expect(all('input').some(input => (input as HTMLInputElement).value === '/srv/dsh-superagent')).toBe(false)
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '25000')
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '')
  await click(zh.save)
  const put = server.requests.find(request => request.path === 'deployment' && request.method === 'PUT')
  expect(put?.body).toEqual({
    revision: 1,
    ops: [
      { op: 'unset', path: ['admissionContextMaxPages'] },
      { op: 'set', path: ['admissionContextTimeoutMs'], value: 25000 },
    ],
  })
  expect(server.setup.machine.admissionContextTimeoutMs).toBe(25000)
  expect(server.setup.machine.admissionContextMaxPages).toBeUndefined()
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.saved)
})

it('handles 409 revision conflicts in the HTTP deployment adapter for both mergeable and conflicting fields', async () => {
  at({ page: 'settings', query: { group: 'deployment' } })
  await mountApp({ openUrl: vi.fn() })
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '24')
  // Concurrent change on a different field bumps server revision to 2, triggering a 409 on revision 1.
  server.setup = { ...server.setup, machine: { ...server.setup.machine, promptMaxChars: 60000 } }
  server.deploymentRevision = 2
  await click(zh.save)
  expect(text()).toContain(zh.saveMerged)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('60000')
  expect(field<HTMLInputElement>(zh.deploymentContextPages).value).toBe('24')
  await click(zh.save)
  expect(server.setup.machine.admissionContextMaxPages).toBe(24)
  expect(server.setup.machine.promptMaxChars).toBe(60000)
  expect(server.deploymentRevision).toBe(3)

  // Concurrent change on the same field surfaces saveConflict while keeping the user's draft value.
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '120000')
  server.setup = { ...server.setup, machine: { ...server.setup.machine, promptMaxChars: 80000 } }
  server.deploymentRevision = 4
  await click(zh.save)
  expect(document.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe(zh.saveConflict)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('120000')
  await click(zh.save)
  expect(server.setup.machine.promptMaxChars).toBe(120000)
  expect(server.deploymentRevision).toBe(5)

  // A 403/400 refusal keeps the user's draft intact and displays the error alert.
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '150000')
  server.deploymentWritable = false
  await click(zh.save)
  expect(document.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe('Deployment settings are read-only')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('150000')
})

it('shows read-only or unavailable state when HTTP /orchestrator/api/deployment is non-writable or unreachable', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.deploymentWritable = false
  at({ page: 'settings', query: { group: 'deployment' } })
  await mountApp({ openUrl: vi.fn() })
  expect(text()).toContain(zh.deploymentReadOnly)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(true)
  expect(all('button').some(button => button.textContent === zh.save)).toBe(false)

  server.deploymentWritable = true
  server.down = true
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(text()).toContain(zh.deploymentUnavailable)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(true)
  server.down = false
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(false)
})
