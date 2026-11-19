/** Regression cases independently reproduced during the standalone runtime review. */
import { afterEach, expect, it, vi } from 'vitest'
import { managedFixture, type ManagedFixture } from './fixtures/paseo-runtime.ts'
import { RuntimeState } from '../src/runtime/state.ts'
import { PaseoRuntime } from '../src/runtime/paseo.ts'
import { loadConfig } from '../src/server/config.ts'
import { trashSync } from './fixtures/trash.ts'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

let f: ManagedFixture | undefined
afterEach(async () => { if (f) { await f.close(); trashSync(f.root); f = undefined }; vi.restoreAllMocks() })

it('keeps the persisted native session identity when an update points at a different conversation', async () => {
  f = await managedFixture()
  const owner = f.runtime.masterId, before = f.adapter.binding(owner)
  const snapshot = f.daemon.snapshots.get(before.agentId)!
  f.daemon.snapshots.set(before.agentId, { ...snapshot, persistence: { ...snapshot.persistence, provider: snapshot.persistence?.provider ?? 'pi', sessionId: 'foreign-native-session' } })
  f.daemon.status(before.agentId, 'idle')
  await vi.waitFor(() => expect(f!.adapter.binding(owner).remoteUpdatedAt).toBe(f!.daemon.snapshots.get(before.agentId)!.updatedAt))
  expect(f.adapter.binding(owner).nativeSessionId).toBe(before.nativeSessionId)
})

it('refuses to consume timeline receipts if the assignment changes during the fetch', async () => {
  f = await managedFixture()
  const { owner } = await f.acceptedTicket()
  const started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const original = f.daemon.client.fetchAgentTimeline.bind(f.daemon.client)
  vi.spyOn(f.daemon.client, 'fetchAgentTimeline').mockImplementationOnce(async (...args) => {
    started.resolve(); await resume.promise; return original(...args)
  })
  const pending = expect(f.sync(owner)).rejects.toThrow('timeline changed')
  await started.promise
  const before = f.adapter.binding(owner)
  f.adapter.state.put('binding', owner, { ...before, generation: before.generation + 1 })
  resume.resolve()
  await pending
  expect(f.adapter.state.list('delivery', owner).some(row => row.consumedAt)).toBe(false)
})

it('settles a child that reached the provider error terminal state instead of holding its parent slot', async () => {
  f = await managedFixture()
  const { owner } = await f.acceptedTicket()
  await f.adapter.createChild(f.adapter.binding(owner), { prompt: 'Child that will fail in the provider' })
  const child = f.adapter.children(owner)[0]!
  f.daemon.status(child.agentId, 'error')
  await vi.waitFor(() => expect(f!.adapter.agent(child.id).status).toBe('error'))
  await f.adapter.reconcile()
  const execution = f.adapter.state.list('execution').find(row => row.childAlias === child.id)!
  expect(['reserved', 'running', 'stopping']).not.toContain(execution.state)
})

it('does not acknowledge a pending durable job callback before the application host is mounted', async () => {
  f = await managedFixture()
  const owner = f.runtime.masterId, root = f.root, daemon = f.daemon
  await f.close(); f = undefined; vi.restoreAllMocks()
  const state = new RuntimeState(join(root, 'paseo.sqlite'))
  state.put('execution', 'completed-before-restart', { id: 'completed-before-restart', owner, generation: 1, kind: 'shell',
    state: 'completed', cwd: root, label: 'Completed test job', createdAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    stdout: 'Durable result that must reach its owner', notification: 'pending' })
  state.close()
  const unmounted = new PaseoRuntime(loadConfig({ stateDir: root }), { client: daemon.client })
  await unmounted.ready
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(unmounted.state.get('execution', 'completed-before-restart')?.notification).toBe('pending')
  expect(unmounted.state.list('delivery', owner).some(row => row.message.id === 'job-ended:completed-before-restart')).toBe(false)
  await unmounted.close()
  f = await managedFixture({}, root, daemon)
  await new Promise(resolve => setTimeout(resolve, 20))
  const execution = f.adapter.state.get('execution', 'completed-before-restart')!
  const hasDelivery = f.adapter.state.list('delivery', owner).some(row => row.message.id === 'job-ended:completed-before-restart')
  await vi.waitFor(() => expect(f!.adapter.state.get('execution', 'completed-before-restart')?.notification).toBe('delivered'))
  expect(hasDelivery || f.adapter.state.list('delivery', owner).some(row => row.message.id === 'job-ended:completed-before-restart')).toBe(true)
})
it('revokes tool access and keeps the native baseline after a foreign identity update and a later fetch', async () => {
  f = await managedFixture()
  const owner = f.runtime.masterId, before = f.adapter.binding(owner)
  const snapshot = f.daemon.snapshots.get(before.agentId)!
  f.daemon.snapshots.set(before.agentId, { ...snapshot, persistence: { ...snapshot.persistence, provider: snapshot.persistence?.provider ?? 'pi', sessionId: 'foreign-native-session' } })
  f.daemon.status(before.agentId, 'idle')
  await vi.waitFor(() => expect(f!.adapter.binding(owner).identityError).toBe('native-session-changed'))
  expect(f.adapter.binding(owner).nativeSessionId).toBe(before.nativeSessionId)
  expect((await f.rpc(owner, 'tools', {})).status).toBe(403)
  await expect(f.adapter.context.sessionController.resolveAgent(owner)).rejects.toThrow('identity')
  expect(f.adapter.binding(owner).nativeSessionId).toBe(before.nativeSessionId)
})
it('cleans a failed child real shell and descendants before delivering a terminal failure to its parent', async () => {
  f = await managedFixture()
  const { owner } = await f.acceptedTicket()
  await f.adapter.createChild(f.adapter.binding(owner), { prompt: 'Parent child' })
  const child = f.adapter.children(owner)[0]!
  await f.adapter.createChild(child, { prompt: 'Nested child' })
  const nested = f.adapter.children(child.id)[0]!
  const started = await f.adapter.jobs.start(child, 'sleep 30', {}, 0, true)
  f.daemon.status(child.agentId, 'error')
  await vi.waitFor(() => expect(f!.adapter.state.list('execution').find(row => row.childAlias === child.id)?.state).toBe('failed'), { timeout: 6000 })
  expect(f.adapter.state.get('execution', String(started.job_id))?.state).toBe('killed')
  expect(f.adapter.binding(nested.id).closed).toBe(true)
  expect(f.adapter.state.list('delivery', owner).some(row => row.message.id.startsWith('child-ended:') && row.body.includes('provider-error'))).toBe(true)
})
it('settles a closed child and delivers its terminal disposition', async () => {
  f = await managedFixture()
  const { owner } = await f.acceptedTicket()
  await f.adapter.createChild(f.adapter.binding(owner), { prompt: 'A child that closes' })
  const child = f.adapter.children(owner)[0]!
  f.daemon.status(child.agentId, 'closed')
  await vi.waitFor(() => expect(f!.adapter.state.list('execution').find(row => row.childAlias === child.id)?.state).toBe('killed'))
  expect(f.adapter.state.list('delivery', owner).some(row => row.body.includes('provider-closed'))).toBe(true)
})
it('keeps a queued followup local while running and sends it once at the next idle without early consumption', async () => {
  f = await managedFixture()
  const owner = f.runtime.masterId, binding = f.adapter.binding(owner)
  f.daemon.status(binding.agentId, 'running')
  await vi.waitFor(() => expect(f!.adapter.agent(owner).status).toBe('running'))
  const message = { id: 'queue-next-turn', role: 'user' as const, content: [{ type: 'text' as const, text: 'NEXT_TURN_ONLY_REVIEW_INPUT' }], source: { kind: 'dsh-superagent' } }
  await f.adapter.agent(owner).followup(message)
  const row = f.adapter.state.get('delivery', `${owner}:${message.id}`)!
  expect(row.queuedAt).toBeTruthy(); expect(row.acceptedAt).toBeUndefined(); expect(row.consumedAt).toBeUndefined()
  expect(f.daemon.sent.filter(row => row.text.includes('NEXT_TURN_ONLY_REVIEW_INPUT'))).toHaveLength(0)
  await f.sync(owner)
  expect(f.adapter.state.get('delivery', row.id)?.consumedAt).toBeUndefined()
  f.daemon.exposeInput = false
  f.daemon.status(binding.agentId, 'idle')
  await vi.waitFor(() => expect(f!.daemon.sent.filter(row => row.text.includes('NEXT_TURN_ONLY_REVIEW_INPUT'))).toHaveLength(1))
  expect(f.adapter.state.get('delivery', row.id)?.acceptedAt).toBeTruthy()
  expect(f.adapter.state.get('delivery', row.id)?.consumedAt).toBeUndefined()
  f.daemon.showInput(f.daemon.sent.findIndex(row => row.text.includes('NEXT_TURN_ONLY_REVIEW_INPUT')))
  await f.sync(owner)
  expect(f.adapter.state.get('delivery', row.id)?.consumedAt).toBeTruthy()
})
it('keeps a pending queue through application reopen without hanging its producer or duplicating the remote message', async () => {
  f = await managedFixture()
  const owner = f.runtime.masterId, binding = f.adapter.binding(owner), root = f.root, daemon = f.daemon
  daemon.status(binding.agentId, 'running'); await vi.waitFor(() => expect(f!.adapter.agent(owner).status).toBe('running'))
  await f.adapter.agent(owner).followup({ id: 'reopen-queue', role: 'user', content: [{ type: 'text', text: 'Recover a local queued input' }], source: { kind: 'dsh-superagent' } })
  await f.close(); f = undefined; vi.restoreAllMocks()
  f = await managedFixture({}, root, daemon)
  await vi.waitFor(() => expect(f!.adapter.state.get('delivery', `${owner}:reopen-queue`)?.acceptedAt).toBeTruthy())
  expect(daemon.sent.filter(row => row.text.includes('Recover a local queued input'))).toHaveLength(1)
  expect(f.adapter.state.get('delivery', `${owner}:reopen-queue`)?.consumedAt).toBeUndefined()
})
it.each([true, false])('cancelled queue stays dormant until explicit resume, keepInbox=%s', async keepInbox => {
  f = await managedFixture()
  const owner = f.runtime.masterId, binding = f.adapter.binding(owner)
  f.daemon.status(binding.agentId, 'running'); await vi.waitFor(() => expect(f!.adapter.agent(owner).status).toBe('running'))
  const message = { id: 'cancel-queued', role: 'user' as const, content: [{ type: 'text' as const, text: 'Cancelled queue input' }], source: { kind: 'dsh-superagent' } }
  await f.adapter.agent(owner).followup(message)
  f.adapter.agent(owner).cancel(undefined, { keepInbox })
  await f.adapter.context.sessionController.resolveAgent(owner); await f.adapter.reconcile()
  expect(f.daemon.sent.filter(row => row.text.includes('Cancelled queue input'))).toHaveLength(0)
  const row = f.adapter.state.get('delivery', `${owner}:${message.id}`)!
  expect(row.consumedAt).toBeUndefined(); expect(!!row.removedAt).toBe(!keepInbox)
  if (keepInbox) {
    await f.adapter.agent(owner).followup(message)
    expect(f.daemon.sent.filter(row => row.text.includes('Cancelled queue input'))).toHaveLength(1)
  }
})
it('returns one real image block without repeating its base64 in the text metadata', async () => {
  f = await managedFixture()
  const owner = f.runtime.masterId
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXGkAAAAASUVORK5CYII='
  const path = join(f.root, 'review-pixel.png'); writeFileSync(path, Buffer.from(data, 'base64'))
  const response = await f.rpc(owner, 'tool', { name: 'superagent_image', args: { path } })
  const result = await response.json() as { content: { type: string; data?: string; text?: string }[] }
  expect(result.content.filter(block => block.type === 'image')).toEqual([{ type: 'image', mimeType: 'image/png', data }])
  expect(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).not.toContain(data)
})
