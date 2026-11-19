/** Provider snapshot retry decisions remain useful without exposing the original diagnostic. */
import { afterEach, expect, it, vi } from 'vitest'
import { managedFixture, type ManagedFixture } from './fixtures/paseo-runtime.ts'
import { trashSync } from './fixtures/trash.ts'
import { transient } from '../src/executor/paseo.ts'
import { latestReport } from '../src/core/index.ts'
import { safeProviderFailure } from '../src/runtime/failures.ts'
let fixture: ManagedFixture | undefined
afterEach(async () => { if (fixture) { await fixture.close(); trashSync(fixture.root); fixture = undefined }; vi.restoreAllMocks() })
it.each([
  ['HTTP 503 Service Unavailable', true], ['HTTP 429 Rate limit', true], ['fetch failed: ECONNRESET', true],
  ['HTTP 401 Unauthorized', false], ['Unknown provider failure', false], ['HTTP 403 Authentication failed; fetch failed', false],
] as const)('keeps the bounded retry category through the real adapter: %s', async (lastError, retryable) => {
  const f = fixture = await managedFixture(), { ticket, owner } = await f.acceptedTicket()
  await f.sync(owner)
  const errors: unknown[] = [], off = f.adapter.context.on('agent/error', ({ agent, error }) => { if (agent.id === owner) errors.push(error) })
  try {
    const id = f.adapter.binding(owner).agentId
    f.daemon.snapshots.set(id, { ...f.daemon.snapshots.get(id)!, lastError: lastError + ' private-diagnostic-marker' })
    f.daemon.status(id, 'error')
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0)); await f.runtime.idle()
    expect(transient(errors[0])).toBe(retryable)
    expect(String(errors[0])).not.toContain('private-diagnostic-marker')
    expect(JSON.stringify(errors[0])).not.toContain(lastError)
    if (retryable) expect(latestReport(f.runtime.store.tickets.get(ticket.id)!)?.state).not.toBe('failed')
    else expect(latestReport(f.runtime.store.tickets.get(ticket.id)!)?.state).toBe('failed')
  } finally { off() }
})
it('accepts no untrusted retry fields and keeps identity failures non-transient', () => {
  expect(transient(safeProviderFailure({ retryable: true, status: 503, code: 'ECONNRESET', token: 'private' }))).toBe(false)
  expect(transient(new Error('The original Paseo conversation identity changed; execution was revoked'))).toBe(false)
  expect(Object.keys(safeProviderFailure('HTTP 503 private'))).toEqual(['retryable', 'name'])
})
it('starts the authorized retry queue from an error terminal state instead of waiting forever for idle', async () => {
  const f = fixture = await managedFixture(), { owner } = await f.acceptedTicket()
  const id = f.adapter.binding(owner).agentId
  f.daemon.snapshots.set(id, { ...f.daemon.snapshots.get(id)!, lastError: 'HTTP 503 Service Unavailable' })
  f.daemon.status(id, 'error'); await vi.waitFor(() => expect(f.adapter.agent(owner).status).toBe('error'))
  await f.adapter.agent(owner).followup({ id: 'controlled-retry-turn', role: 'user', content: [{ type: 'text', text: 'Resume the authorized assignment after backoff' }], source: { kind: 'dsh-superagent' } })
  expect(f.daemon.sent.filter(row => row.text.includes('Resume the authorized assignment after backoff'))).toHaveLength(1)
  expect(f.adapter.state.get('delivery', `${owner}:controlled-retry-turn`)?.acceptedAt).toBeTruthy()
})

async function lostReceiptThenError(mode: 'queue' | 'steer') {
  let fail = true
  const f = fixture = await managedFixture({ afterRemoteSend: () => { if (fail) { fail = false; throw new Error('Synthetic receipt failure') } } })
  const owner = f.runtime.masterId, agentId = f.adapter.binding(owner).agentId
  const message = { id: 'lost-receipt-then-error', role: 'user' as const, content: [{ type: 'text' as const, text: 'UNIQUE_RETRY_INPUT' }], source: { kind: 'dsh-superagent' } }
  const send = () => mode === 'queue' ? f.adapter.agent(owner).followup(message) : f.adapter.agent(owner).steer(message)
  await expect(send()).rejects.toThrow('Synthetic receipt failure')
  expect(f.adapter.state.get('delivery', `${owner}:${message.id}`)?.acceptedAt).toBeUndefined()
  f.daemon.snapshots.set(agentId, { ...f.daemon.snapshots.get(agentId)!, lastError: 'HTTP 503 Service Unavailable' })
  f.daemon.status(agentId, 'error'); await vi.waitFor(() => expect(f.adapter.agent(owner).status).toBe('error'))
  return { ...f, owner, agentId, message, send }
}
it.each(['queue', 'steer'] as const)('repairs a lost %s receipt from timeline evidence without resending the input', async mode => {
  const f = await lostReceiptThenError(mode)
  const row = () => f.adapter.state.get('delivery', f.owner + ':' + f.message.id)!
  expect(row()).toMatchObject({ acceptedAt: expect.any(String), consumedAt: expect.any(String) })
  await f.adapter.reconcile()
  expect(f.daemon.sent).toHaveLength(1)
  await Promise.all([f.send(), f.send()])
  expect(f.daemon.sent).toHaveLength(2)
  expect(f.daemon.sent.filter(row => row.text.includes('UNIQUE_RETRY_INPUT'))).toHaveLength(1)
  expect(new Set(f.daemon.sent.map(row => row.agentId))).toEqual(new Set([f.agentId]))
  expect(f.adapter.agent(f.owner).session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
})

async function interruptedPrompt() {
  const f = fixture = await managedFixture()
  const owner = f.runtime.masterId, { agentId } = f.adapter.binding(owner)
  const requestId = 'accepted-prompt', id = f.runtime.sessions.promptedId(requestId)
  const row = () => f.adapter.state.get('delivery', owner + ':' + id)!
  const prompt = () => f.runtime.sessions.prompt(owner, requestId, 'Original accepted text', 'steer')
  const restart = (epoch: string) => { f.daemon.timelineEpoch = epoch; f.daemon.status(agentId, 'idle') }
  await prompt()
  expect(row().acceptedAt).toBeTruthy()
  return { ...f, owner, agentId, id, row, prompt, restart }
}

it('recovers an interrupted input across daemon epochs and stops after a reply', async () => {
  const f = await interruptedPrompt()
  await f.sync(f.owner)
  const originalReceipt = f.row().consumedAt
  expect(originalReceipt).toBeTruthy()
  await Promise.all([f.prompt(), f.prompt()])
  expect(f.daemon.sent).toHaveLength(1)

  f.restart('restarted-once')
  await f.adapter.reconcile()
  expect(f.daemon.sent).toHaveLength(2)

  f.restart('restarted-twice')
  await f.adapter.reconcile()
  expect(f.daemon.sent).toHaveLength(3)
  expect(new Set(f.daemon.sent.map(row => row.messageId)).size).toBe(3)

  f.daemon.append(f.agentId, { type: 'assistant_message', text: 'Work completed' })
  f.restart('restarted-after-completion')
  await f.adapter.reconcile()
  await f.prompt()
  expect(f.daemon.sent).toHaveLength(3)
  expect(f.row()).toMatchObject({ consumedAt: originalReceipt, finishedAt: expect.any(String) })
  expect(f.adapter.agent(f.owner).session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === f.id)).toHaveLength(1)
})

it('reuses the same continuation reservation when the wake send fails', async () => {
  const f = await interruptedPrompt()
  await f.sync(f.owner)
  f.restart('restarted')
  const send = vi.spyOn(f.daemon.client, 'sendAgentMessage').mockRejectedValueOnce(new Error('Transport unavailable'))
  await f.adapter.reconcile()
  expect(f.daemon.sent).toHaveLength(1)
  await f.adapter.reconcile()
  expect(f.daemon.sent).toHaveLength(2)
  expect(send.mock.calls.map(([, , options]) => options?.messageId)).toEqual([f.daemon.sent[1]!.messageId, f.daemon.sent[1]!.messageId])
})

it('lets the next application process resume a main input held during shutdown', async () => {
  const first = await interruptedPrompt()
  await first.sync(first.owner)
  await first.close()
  fixture = undefined
  const reopened = fixture = await managedFixture({}, first.root, first.daemon)
  await reopened.adapter.reconcile()
  expect(first.daemon.sent).toHaveLength(2)
  await reopened.adapter.reconcile()
  expect(first.daemon.sent).toHaveLength(2)
})

it('does not automatically restart a manually cancelled input', async () => {
  const f = await interruptedPrompt()
  await f.sync(f.owner)
  const epoch = f.adapter.binding(f.owner).resumeEpoch ?? 0
  f.adapter.agent(f.owner).cancel(undefined, { keepInbox: true })
  await vi.waitFor(() => expect(f.adapter.binding(f.owner).resumeEpoch).toBe(epoch + 1))
  f.restart('new-daemon-after-cancel')
  await f.adapter.reconcile()
  expect(f.daemon.sent).toHaveLength(1)
})

it('reports a possible prior tool effect before starting another turn', async () => {
  const f = await interruptedPrompt()
  f.daemon.append(f.agentId, { type: 'tool_call', name: 'shell', status: 'completed', detail: 'Command ran' })
  f.restart('restarted')
  await f.adapter.reconcile()
  await expect(f.prompt()).rejects.toThrow(/tool.*original Paseo conversation/i)
  expect(f.daemon.sent).toHaveLength(1)
  expect(f.adapter.agent(f.owner).session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true)
})

it('keeps ambiguous copies pending without claiming or resending a remote input', async () => {
  let fail = true
  const f = fixture = await managedFixture({ afterRemoteSend: () => { if (fail) { fail = false; throw new Error('Fault before receipt') } } })
  const owner = f.runtime.masterId, { agentId } = f.adapter.binding(owner)
  const submit = () => f.runtime.sessions.prompt(owner, 'ambiguous', 'Do this once', 'steer')
  await expect(submit()).rejects.toThrow('Fault before receipt')
  const row = f.adapter.state.list('delivery', owner)[0]!
  f.daemon.history.get(agentId)![0]!.item = { type: 'user_message', messageId: 'copy-1', text: row.body }
  f.daemon.append(agentId, { type: 'user_message', messageId: 'copy-2', text: row.body })
  f.daemon.status(agentId, 'error')
  await expect(submit()).rejects.toThrow('awaiting identity evidence')
  expect(f.daemon.sent).toHaveLength(1)
  expect(f.adapter.state.get('delivery', row.id)?.consumedAt).toBeUndefined()
})

it.each([
  ['queue', 'cancel'], ['steer', 'cancel'], ['queue', 'generation'], ['steer', 'generation'],
] as const)('rechecks %s receipt recovery after %s while awaiting remote history', async (mode, revoke) => {
  const f = await lostReceiptThenError(mode), before = f.adapter.binding(f.owner), sent = f.daemon.sent.length
  const history = f.daemon.client.fetchAgentTimeline.bind(f.daemon.client)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  vi.spyOn(f.daemon.client, 'fetchAgentTimeline').mockImplementationOnce(async (...args) => { entered(); await gate; return history(...args) })
  const sending = f.send(), result = sending.then(() => undefined, error => error)
  await ready
  if (revoke === 'cancel') {
    f.adapter.agent(f.owner).cancel(undefined, { keepInbox: true })
    await vi.waitFor(() => expect(f.adapter.binding(f.owner).resumeEpoch).toBe((before.resumeEpoch ?? 0) + 1))
  } else f.adapter.state.put('binding', f.owner, { ...before, generation: before.generation + 1 })
  release()
  const error = await result
  if (revoke === 'generation') expect(error).toBeInstanceOf(Error)
  expect(f.daemon.sent).toHaveLength(sent)
  expect(f.adapter.state.get('delivery', f.owner + ':' + f.message.id)?.consumedAt).toBeTruthy()
})
