/** Current notice projections replace same-key values while preserving consumed and in-flight receipts. */
import { afterEach, expect, it, vi } from 'vitest'
import { managedFixture, type ManagedFixture } from './fixtures/paseo-runtime.ts'
import { trashSync } from './fixtures/trash.ts'
import type { UserMessage } from '../src/runtime/types.ts'
let fixture: ManagedFixture | undefined
afterEach(async () => { if (fixture) { await fixture.close(); trashSync(fixture.root); fixture = undefined }; vi.useRealTimers(); vi.restoreAllMocks() })
const notice = (id: string, text: string, mergeKey?: string): UserMessage => ({ id, role: 'user', content: [{ type: 'text', text }],
  source: { kind: 'dsh-superagent', form: 'notice', ...(mergeKey ? { mergeKey } : {}) } } as UserMessage)
async function deliver(f: ManagedFixture, id: string): Promise<string> {
  const owner = f.runtime.masterId
  await f.runtime.sessions.prompt(owner, id, 'Continue', 'steer')
  return f.daemon.sent.at(-1)!.text
}

it('replaces same-key notices in subsequent deliveries and retains earlier receipts and unkeyed notices', async () => {
  const f = fixture = await managedFixture(), owner = f.runtime.masterId, agent = f.adapter.agent(owner)
  await agent.inject(notice('old', 'OLD_NOTICE_VALUE', 'settings'))
  await agent.inject(notice('standalone', 'SEPARATE_NOTICE'))
  expect(f.daemon.sent).toHaveLength(0)
  expect(await deliver(f, 'notice-first')).toContain('OLD_NOTICE_VALUE')
  await f.sync(owner)
  const old = f.adapter.state.get('notice', owner + ':old')!
  expect(old.consumedAt).toBeTruthy()

  await agent.inject(notice('new', 'NEW_NOTICE_VALUE', 'settings'))
  const body = await deliver(f, 'notice-next')
  expect(body).toContain('NEW_NOTICE_VALUE')
  expect(body).toContain('SEPARATE_NOTICE')
  expect(body).not.toContain('OLD_NOTICE_VALUE')
  expect(f.adapter.state.get('notice', old.id)).toEqual({ ...old, supersededAt: expect.any(String) })
  await f.sync(owner)
  expect(f.adapter.state.get('notice', owner + ':new')?.consumedAt).toBeTruthy()
})

it('records only notices included in the delivery the timeline acknowledges', async () => {
  const f = fixture = await managedFixture(), owner = f.runtime.masterId, agent = f.adapter.agent(owner)
  f.daemon.exposeInput = false
  const receipt = (id: string) => f.adapter.state.get('notice', owner + ':' + id)
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-18T00:00:00Z'))
  await agent.inject(notice('first', 'OLD_NOTICE', 'same-key'))
  await deliver(f, 'receipt-first')
  await agent.inject(notice('second', 'NEW_NOTICE', 'same-key'))
  const body = await deliver(f, 'receipt-second')
  expect(body).toContain('NEW_NOTICE')
  expect(body).not.toContain('OLD_NOTICE')
  expect(receipt('first')?.createdAt).toBe(receipt('second')?.createdAt)
  expect(receipt('first')).toMatchObject({ supersededAt: expect.any(String) })
  expect(receipt('first')?.consumedAt).toBeUndefined()
  f.daemon.showInput(0)
  await f.sync(owner)
  expect(receipt('first')?.consumedAt).toBeTruthy()
  expect(receipt('second')?.consumedAt).toBeUndefined()
  f.daemon.showInput(1)
  await f.sync(owner)
  expect(receipt('second')?.consumedAt).toBeTruthy()
})

it('reopens with the current notice and the prior notice receipt', async () => {
  const first = fixture = await managedFixture(), owner = first.runtime.masterId
  await first.adapter.agent(owner).inject(notice('before-restart', 'RESTART_OLD', 'restart-key'))
  await deliver(first, 'before-restart-delivery')
  await first.sync(owner)
  const old = first.adapter.state.get('notice', owner + ':before-restart')!
  await first.adapter.agent(owner).inject(notice('replacement', 'RESTART_NEW', 'restart-key'))
  await first.close(); fixture = undefined; vi.restoreAllMocks()
  const reopened = fixture = await managedFixture({}, first.root, first.daemon)
  const body = await deliver(reopened, 'after-restart-delivery')
  expect(body).toContain('RESTART_NEW')
  expect(body).not.toContain('RESTART_OLD')
  expect(reopened.adapter.state.get('notice', old.id)).toEqual({ ...old, supersededAt: expect.any(String) })
  expect(first.daemon.creates).toHaveLength(1)
})
