/** Production adapter contracts through its real SQLite and HTTP boundaries; the daemon is injected, models are not invoked. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assessorProfile, executorProfile, managedFixture, type ManagedFixture } from './fixtures/paseo-runtime.ts'
import { trashSync } from './fixtures/trash.ts'
import { latestAssignment } from '../src/core/index.ts'
import { deferred, track } from './fixtures/async.ts'
import { feishu } from './fixtures/host.ts'

let fixture: ManagedFixture | undefined
const open = async (options = {}) => fixture = await managedFixture(options)
afterEach(async () => { if (fixture) { await fixture.close(); trashSync(fixture.root, { recursive: true, force: true }); fixture = undefined }; vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('creates one visible fixed agent, launches the selected Profile and exposes only the application tools for its role', async () => {
  const f = await open(), owner = f.runtime.masterId, binding = f.adapter.binding(owner)
  await Promise.all([f.adapter.context.sessionController.resolveAgent(owner), f.adapter.context.sessionController.resolveAgent(owner)])
  expect(f.daemon.creates).toHaveLength(1)
  expect(f.daemon.creates[0]).toMatchObject({ agentId: binding.agentId, idempotencyKey: `superagent:${binding.agentId}`, provider: 'pi', model: assessorProfile.model, thinkingOptionId: assessorProfile.thinkingOptionId })
  expect(f.daemon.creates[0]).not.toHaveProperty('modeId')
  expect(f.adapter.link(owner)).toEqual({ serverId: 'srv_test', agentId: binding.agentId })
  const tools = await (await f.rpc(owner, 'tools', {})).json() as { tools: { name: string }[] }
  expect(tools.tools.filter(tool => tool.name.startsWith('orchestrator_'))).toHaveLength(14)
  expect(tools.tools.some(tool => tool.name === 'superagent_subagent')).toBe(false)
  for (const name of ['bash', 'subagent', 'codemode', 'tool_search', 'powershell', 'write', 'made_up_tool']) {
    expect(await f.adapter.authorize(binding, name, {}), name).toBeTruthy()
  }
  expect(await f.adapter.authorize(binding, 'orchestrator_read', {})).toBeUndefined()
  expect(f.daemon.creates[0]?.systemPrompt).toContain('superagent-tool call orchestrator_read --stdin')
  expect(f.daemon.creates[0]?.systemPrompt).toContain('orchestrator_eval_decide')
  expect(f.daemon.creates[0]?.systemPrompt).toContain('## Policy')
})
it('labels new Paseo main and worker sessions and applies the instance prefix exactly once on rename', async () => {
  const f = await open({ instanceId: 'project-a' })
  expect(f.daemon.creates[0]?.title).toBe('[project-a] Superagent orchestrator')
  const { owner, ticket } = await f.acceptedTicket()
  const worker = f.adapter.binding(owner)
  expect(f.daemon.creates.find(agent => agent.agentId === worker.agentId)?.title).toBe(`[project-a] Superagent ${ticket.id}`)
  const renamed = vi.spyOn(f.daemon.client, 'updateAgent')
  for (const title of ['Work in progress', '[project-a] Work in progress']) {
    await f.adapter.context.sessionController.rename({ sessionId: owner, title })
    expect(renamed).toHaveBeenLastCalledWith(worker.agentId, { name: '[project-a] Work in progress' })
  }
})
it('passes only the instance Git and forge CLI environment to native provider shells', async () => {
  const forge = { GH_CONFIG_DIR: '/fixture/project-a/gh', GLAB_CONFIG_DIR: '/fixture/project-a/glab',
    GLAB_AGENT_REAL: '/fixture/bin/glab', GITLAB_HOST: 'gitlab.example.test' }
  for (const [name, value] of Object.entries(forge)) vi.stubEnv(name, value)
  for (const name of ['GH_TOKEN', 'GLAB_TOKEN', 'PASEO_PASSWORD', 'DINGTALK_CLIENT_SECRET', 'UNRELATED_VARIABLE']) vi.stubEnv(name, 'fixture-value')
  const f = await open()
  await f.acceptedTicket()
  expect(f.daemon.creates.map(input => input.provider)).toEqual(['pi', 'codex'])
  for (const input of f.daemon.creates) {
    expect(input.env).toMatchObject({ ...forge, GIT_CONFIG_GLOBAL: join(f.root, 'worker-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1' })
    expect(input.env).not.toHaveProperty('UNRELATED_VARIABLE')
    expect(Object.keys(input.env!).filter(name => /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL/i.test(name))).toEqual([])
  }
})
it('enforces main noWait against the usable controlled shell and permits a short command', async () => {
  const f = await open(), owner = f.runtime.masterId
  for (const args of [{ command: 'sleep 1' }, { command: 'printf hi', timeoutMs: 30001 }]) {
    const result = await (await f.rpc(owner, 'tool', { name: 'superagent_shell', args })).json()
    expect(result).toHaveProperty('isError', true)
  }
  expect(f.adapter.state.list('execution')).toHaveLength(0)
  const result = await (await f.rpc(owner, 'tool', { name: 'superagent_shell', args: { command: 'printf controlled-short' } })).json() as { content: { text: string }[] }
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: 'completed', output: 'controlled-short', exit_code: 0 })
})
it('recovers an accepted remote message after local commit failure without copying it, including concurrent retries', async () => {
  let fail = true
  const f = await open({ afterRemoteSend: () => { if (fail) { fail = false; throw new Error('Injected local receipt failure') } } })
  const owner = f.runtime.masterId, message = { id: 'local-commit-fault', role: 'user' as const, content: [{ type: 'text' as const, text: 'A single durable input' }], source: { kind: 'dsh-superagent', form: 'relay' } }
  await expect(f.adapter.agent(owner).steer(message)).rejects.toThrow('Injected local receipt')
  expect(f.adapter.state.get('delivery', `${owner}:${message.id}`)?.acceptedAt).toBeUndefined()
  await Promise.all([f.adapter.agent(owner).steer(message), f.adapter.agent(owner).steer(message)])
  expect(f.daemon.sent.filter(row => row.text.includes('A single durable input'))).toHaveLength(1)
  expect(f.adapter.state.get('delivery', `${owner}:${message.id}`)?.acceptedAt).toBeTruthy()
  expect(f.adapter.agent(owner).session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === message.id)).toHaveLength(1)
})

it('keeps acknowledged input unread until the daemon exposes it, even when a turn is cancelled', async () => {
  const f = await open(), owner = f.runtime.masterId
  f.daemon.exposeInput = false
  await f.runtime.sessions.prompt(owner, 'cancel-before-read', 'Pending input', 'steer')
  const id = f.runtime.sessions.promptedId('cancel-before-read')
  const input = () => f.adapter.state.get('delivery', owner + ':' + id)
  expect(input()?.acceptedAt).toBeTruthy()
  expect(input()?.consumedAt).toBeUndefined()
  f.adapter.agent(owner).cancel(undefined, { keepInbox: true })
  await f.adapter.context.sessionController.resolveAgent(owner)
  expect(await (await f.rpc(owner, 'tool', { name: 'orchestrator_read', args: { resource: 'guide' } })).json()).toHaveProperty('isError', true)
  expect(input()?.removedAt).toBeUndefined()
  expect(input()?.consumedAt).toBeUndefined()
  f.daemon.showInput(0)
  await f.sync(owner)
  expect(input()?.consumedAt).toBeTruthy()
})




it('delivers a new prompt and policy revision with the next input and tracks it after a timeline receipt', async () => {
  const f = await open(), owner = f.runtime.masterId, changed = f.runtime.prompts.current()
  const before = f.adapter.binding(owner).contextRevision
  const version = f.runtime.prompts.save({ ...changed.config, communication: 'Current application instructions' }, changed.revision, 'panel')
  const settings = f.runtime.store.settings()
  f.runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'observe' } })
  expect(f.daemon.sent).toHaveLength(0)
  await f.runtime.sessions.prompt(owner, 'context-update', 'Continue with current context', 'steer')
  const body = f.daemon.sent.at(-1)!.text
  expect(body.indexOf('<superagent_context_v1')).toBeLessThan(body.indexOf('Continue with current context'))
  expect(body).toContain('Current application instructions')
  expect(f.adapter.binding(owner).contextRevision).not.toBe(before)
  await f.sync(owner)
  expect(f.runtime.sessions.mayRead(owner, version.revision)).toBe(true)
  await f.runtime.sessions.prompt(owner, 'context-unchanged', 'No duplicate context required', 'steer')
  expect(f.daemon.sent.at(-1)!.text).not.toContain('<superagent_context_v1')
})


it('keeps the original provider identity and rewrites the tool script when reopening the instance', async () => {
  const f = await open(), owner = f.runtime.masterId, before = f.adapter.binding(owner)
  const wrapper = join(dirname(before.file), 'bin', 'superagent-tool')
  expect(readFileSync(wrapper, 'utf8')).toContain('/src/runtime/tool-cli.ts')
  await f.close(); fixture = undefined
  fixture = await managedFixture({}, f.root, f.daemon)
  expect(fixture.adapter.binding(owner)).toMatchObject({ agentId: before.agentId, nativeSessionId: before.nativeSessionId, provider: before.provider })
  expect(f.daemon.creates).toHaveLength(1)
  expect(readFileSync(wrapper, 'utf8')).toContain('/src/runtime/tool-cli.ts')
  await fixture.runtime.sessions.prompt(owner, 'after-reconnect', 'Continue on this original ID', 'steer')
  await fixture.sync(owner)
  expect(fixture.adapter.state.list('delivery', owner).some(row => row.body.includes('Continue on this original ID') && row.consumedAt)).toBe(true)
})


it('reconciles rebuilt history by the delivery frame and retains distinct direct messages', async () => {
  const f = await open(), owner = f.runtime.masterId, { agentId } = f.adapter.binding(owner)
  await f.runtime.sessions.prompt(owner, 'before-rebuild', 'Same text', 'steer')
  const original = f.adapter.state.list('delivery', owner)[0]!
  const history = f.daemon.history.get(agentId)!
  history[0]!.item = { type: 'user_message', messageId: 'rebuilt-id', text: original.body }
  f.daemon.append(agentId, { type: 'user_message', messageId: 'direct-1', text: 'Same text' })
  f.daemon.append(agentId, { type: 'user_message', messageId: 'direct-2', text: 'Same text' })
  await f.sync(owner)
  const rows = f.adapter.state.list('delivery', owner)
  expect(rows).toHaveLength(3)
  expect(rows.find(row => row.id === original.id)).toMatchObject({ consumedAt: expect.any(String), remoteId: original.remoteId, nativeMessageId: 'rebuilt-id' })
  expect(rows.filter(row => row.message.source.kind === 'user').map(row => row.remoteId)).toEqual(['direct-1', 'direct-2'])
  await f.sync(owner)
  expect(f.adapter.agent(owner).session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(3)
})



it('does not attribute timeline entries from another native session', async () => {
  const f = await open(), owner = f.runtime.masterId, { agentId } = f.adapter.binding(owner)
  const old = f.daemon.snapshots.get(agentId)!
  f.daemon.snapshots.set(agentId, { ...old, persistence: { ...old.persistence!, sessionId: 'foreign-native-session' } })
  f.daemon.history.get(agentId)!.push({ seqStart: 1, seqEnd: 1, item: { type: 'user_message', text: 'Foreign content', messageId: 'foreign-input' } })
  await expect(f.adapter.context.sessionController.inspect(owner)).rejects.toThrow('original Paseo conversation identity changed')
  expect(f.adapter.state.list('delivery', owner)).toHaveLength(0)
})

it('deduplicates direct timeline entries by their native ID after a rebuild', async () => {
  const f = await open(), owner = f.runtime.masterId, { agentId } = f.adapter.binding(owner)
  const history = f.daemon.history.get(agentId)!
  f.daemon.append(agentId, { type: 'user_message', clientMessageId: 'client', messageId: 'native', text: 'Direct user input' })
  await f.sync(owner)
  history[0]!.item = { type: 'user_message', messageId: 'native', text: 'Direct user input' }
  await f.sync(owner)
  expect(f.adapter.state.list('delivery', owner)).toMatchObject([{ remoteId: 'client', nativeMessageId: 'native', consumedAt: expect.any(String) }])
})



it('binds worker tools to server identity and rejects ended and old assignment generations at dispatch', async () => {
  const f = await open(), { ticket, owner } = await f.acceptedTicket(), worker = f.adapter.binding(owner)
  const call = await f.sync(owner), tools = await (await f.rpc(owner, 'tools', {})).json() as { tools: { name: string }[] }
  expect(tools.tools.filter(tool => tool.name.startsWith('orchestrator_'))).toHaveLength(6)
  expect(await f.adapter.authorize(worker, 'orchestrator_route', { role: 'orchestrator', ticket_id: 'forged' })).toBeTruthy()
  const execution = await f.rpc(owner, 'tool', { name: 'orchestrator_route', args: { role: 'orchestrator', ticket_id: 'forged' } })
  expect(await execution.json()).toHaveProperty('isError', true)
  f.adapter.state.put('binding', owner, { ...worker, generation: worker.generation + 1 })
  expect(await (await f.rpc(owner, 'tool', { name: 'orchestrator_read', args: { resource: 'guide' } })).json()).toHaveProperty('isError', true)
  f.adapter.state.put('binding', owner, worker)
  const ended = { ...f.runtime.store.tickets.get(ticket.id)!, ended: { at: new Date().toISOString(), by: 'operator', reason: 'test', outcome: 'cancelled' } }
  f.runtime.store.tickets.save(ended as never)
  for (const name of ['read', 'superagent_shell', 'orchestrator_report', 'superagent_subagent']) expect(await f.adapter.authorize(worker, name, {}), name).toBeTruthy()
  expect(latestAssignment(ticket)).toBeTruthy()
  expect(readFileSync(worker.file, 'utf8')).not.toContain('forged')
})
it('waits for previous assignment child cleanup before ensuring the original worker and handing over unread input once', async () => {
  const f = await open(), trigger = feishu('1', '@bot 修复回归')
  f.runtime.receive(trigger); await f.runtime.idle()
  expect(await (await f.rpc(f.runtime.masterId, 'tool', { name: 'orchestrator_route', args: { decisions: [{ kind: 'accept', trigger_id: trigger.id,
    title: 'Fix regression', worktree_name: 'regression', acknowledgement: 'Received' }] } })).json()).not.toHaveProperty('isError')
  await f.runtime.idle()
  const ticket = f.runtime.store.tickets.list()[0]!, owner = `worker-${ticket.id}`, original = f.adapter.binding(owner)
  await f.adapter.createChild(original, { prompt: 'Controlled previous-assignment child' })
  const child = f.adapter.children(owner)[0]!, cleanup = deferred(), entered = deferred()
  try {
    const cancel = f.daemon.client.cancelAgent.bind(f.daemon.client)
    vi.spyOn(f.daemon.client, 'cancelAgent').mockImplementation(async id => {
      if (id === child.agentId) { entered.resolve(); await cleanup.promise }
      return cancel(id)
    })
    f.daemon.exposeInput = false
    const more = feishu('2', '@bot Unread input before delayed cleanup', { root_id: trigger.meta.messageId })
    f.runtime.receive(more); await f.runtime.idle()
    const attached = await f.sync(f.runtime.masterId)
    expect(await (await f.rpc(f.runtime.masterId, 'tool', { name: 'orchestrator_route', args: { decisions: [{ kind: 'attach', trigger_id: more.id, ticket_id: ticket.id }] } })).json()).not.toHaveProperty('isError')
    await f.runtime.idle()
    const input = f.runtime.store.tickets.get(ticket.id)!.inputs.find(input => input.kind === 'trigger' && input.triggerId === more.id)
    if (!input || input.kind !== 'trigger') throw new Error('Expected the attached unread trigger input')
    const delivery = f.adapter.state.get('delivery', `${owner}:${f.runtime.sessions.promptedId(input.id)}`)!
    expect(input.readAt).toBeNull(); expect(delivery.acceptedAt).toBeTruthy(); expect(delivery.consumedAt).toBeUndefined()
    const stopped = vi.spyOn(f.runtime.executor as unknown as { stopped(id: string): Promise<void> }, 'stopped')
    const ensure = vi.spyOn(f.runtime.sessions, 'ensure'), sends = () => f.daemon.sent.filter(row => row.agentId === original.agentId).length, sent = sends()
    f.runtime.executor.resume()
    const pumping = f.runtime.pump()
    await entered.promise
    await vi.waitFor(() => expect(stopped.mock.calls.some(([id]) => id === ticket.id) || ensure.mock.calls.some(([id]) => id === owner)).toBe(true))
    expect(ensure.mock.calls.filter(([id]) => id === owner)).toHaveLength(0)
    expect(f.adapter.binding(owner)).toMatchObject({ assignmentId: original.assignmentId, generation: original.generation })
    expect(latestAssignment(f.runtime.store.tickets.get(ticket.id)!)?.report).toBeUndefined()
    expect(sends()).toBe(sent)
    // The actual SQLite-backed guard still rejects replacement while the old child owns live work.
    await expect(f.adapter.context.sessionController.resolveAgent(owner)).rejects.toThrow('Previous assignment owned work must finish cleanup before replacement')
    cleanup.resolve(); await pumping; await f.runtime.idle()
    const assignment = latestAssignment(f.runtime.store.tickets.get(ticket.id)!)!, current = f.adapter.binding(owner)
    expect(assignment).toMatchObject({ state: 'running' }); expect(assignment.report).toBeUndefined()
    expect(assignment.id).not.toBe(original.assignmentId)
    expect(current).toMatchObject({ agentId: original.agentId, nativeSessionId: original.nativeSessionId, assignmentId: assignment.id, generation: original.generation + 1 })
    expect(f.daemon.creates.filter(row => row.agentId === original.agentId)).toHaveLength(1)
    expect(f.adapter.binding(child.id).closed).toBe(true)
    expect(f.daemon.sent.filter(row => row.messageId === delivery.remoteId)).toHaveLength(1)
    expect(await (await f.rpc(owner, 'tool', { name: 'orchestrator_read', args: { resource: 'guide' } })).json()).toHaveProperty('isError', true)
    f.daemon.showInput(f.daemon.sent.findIndex(row => row.messageId === delivery.remoteId))
    await f.sync(owner)
    await vi.waitFor(() => expect(f.runtime.store.tickets.get(ticket.id)!.inputs.find(row => row.id === input.id)).toMatchObject({ deliveredTo: assignment.id, readAt: expect.any(String) }))
    expect(f.adapter.state.get('delivery', delivery.id)).toMatchObject({ assignmentId: assignment.id, generation: current.generation, consumedAt: expect.any(String) })
    expect(f.daemon.sent.filter(row => row.messageId === delivery.remoteId)).toHaveLength(1)
  } finally { cleanup.resolve(); await f.runtime.idle() }
})
it.each(['cancel', 'generation', 'stop'] as const)('rechecks an async business handler before its transaction after %s without partial writes', async revoke => {
  const f = await open(), { owner, ticket } = await f.acceptedTicket()
  let resume!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  f.adapter.agent(owner).tools.register({ name: 'orchestrator_ack', execute: async () => {
    entered(); await new Promise<void>(resolve => { resume = resolve })
    f.runtime.store.atomic(() => { f.runtime.store.set('test-stale-commit' as never, 'bad') }); return { committed: true }
  } })
  const pending = f.rpc(owner, 'tool', { name: 'orchestrator_ack', args: {} })
  await waiting
  if (revoke === 'cancel') {
    f.adapter.agent(owner).cancel(undefined, { keepInbox: true })
    expect(await (await pending).json()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('cancelled') }] })
  }
  else if (revoke === 'generation') { const binding = f.adapter.binding(owner); f.adapter.state.put('binding', owner, { ...binding, generation: binding.generation + 1 }) }
  else f.runtime.engine.stopTicket(ticket.id)
  resume()
  if (revoke !== 'cancel') expect(await (await pending).json()).toHaveProperty('isError', true)
  expect(f.runtime.store.get('test-stale-commit' as never)).toBeUndefined()
})
it('keeps a child registered while its real shell continues after turn idle, and stops descendants on human handoff', async () => {
  const f = await open(), { owner } = await f.acceptedTicket(), parent = f.adapter.binding(owner)
  await f.adapter.createChild(parent, { prompt: 'Isolated child task' })
  const child = f.adapter.children(owner)[0]!
  f.daemon.status(child.agentId, 'running')
  await vi.waitFor(() => expect(f.adapter.state.list('execution').find(row => row.childAlias === child.id)?.state).toBe('running'))
  const shell = await (await f.rpc(child.id, 'tool', { name: 'superagent_shell', args: { command: 'sleep 30', run_in_background: true } })).json() as { content: { text: string }[] }
  const job = JSON.parse(shell.content[0]!.text)
  expect(job.status).toBe('running')
  f.daemon.status(child.agentId, 'idle')
  await f.adapter.reconcile()
  await vi.waitFor(() => expect(f.adapter.agent(child.id).status).toBe('idle'))
  expect(f.adapter.state.list('execution').find(row => row.childAlias === child.id)?.state).toBe('running')
  expect(await f.adapter.authorize(child, 'orchestrator_route', { role: 'orchestrator' })).toBeTruthy()
  const retained = await (await f.rpc(owner, 'tool', { name: 'superagent_shell', args: { command: 'sleep 30', run_in_background: true } })).json() as { content: { text: string }[] }
  const retainedJob = JSON.parse(retained.content[0]!.text)
  const report = await (await f.rpc(owner, 'tool', { name: 'orchestrator_report', args: { state: 'blocked', summary: 'Need a human', human_action: 'Continue?' } })).json()
  expect(report).not.toHaveProperty('isError')
  f.daemon.status(parent.agentId, 'idle')
  await vi.waitFor(() => expect(f.adapter.binding(owner).handedBack).toBe(true))
  await vi.waitFor(() => expect(f.adapter.binding(child.id).closed).toBe(true))
  expect(f.adapter.state.get('execution', retainedJob.job_id)).toMatchObject({ state: 'running', handedBack: true, generation: parent.generation })
  expect(f.runtime.executor.activeCount()).toBe(0)
  expect(f.daemon.archived).toContain(child.agentId)
})
it('allows an authorized ready report to end its own ticket and commit the report and relay atomically', async () => {
  const f = await open(), { ticket, owner } = await f.acceptedTicket()
  const result = await (await f.rpc(owner, 'tool', { name: 'orchestrator_report', args: { state: 'ready', summary: 'Completed without a pull request' } })).json()
  expect(result).not.toHaveProperty('isError')
  const current = f.runtime.store.tickets.get(ticket.id)!
  expect(current.ended).toBeTruthy(); expect(current.assignments.at(-1)?.report).toMatchObject({ state: 'ready', summary: 'Completed without a pull request' })
  expect(await f.adapter.authorize(f.adapter.binding(owner), 'read', {})).toBeTruthy()
  await f.runtime.idle()
  expect(f.adapter.state.list('delivery', f.runtime.masterId).some(row => row.body.includes('Completed without a pull request'))).toBe(true)
})

it('switches the idle main profile across providers and uses the worker selection only for newly created workers', async () => {
  const f = await open({ instanceId: 'project-a' }), owner = f.runtime.masterId, original = f.adapter.binding(owner)
  const worker = await f.acceptedTicket()
  const firstWorker = f.adapter.binding(worker.owner)
  f.daemon.status(original.agentId, 'running')
  const settings = f.runtime.store.settings()
  await f.runtime.settings.save('eval', { ...settings.eval, model: executorProfile }, f.runtime.store.blockRevision('eval'), 'panel')
  await f.runtime.settings.save('executor', { ...settings.executor, model: assessorProfile }, f.runtime.store.blockRevision('executor'), 'panel')
  await f.adapter.reconcile()
  expect(f.adapter.binding(owner).agentId).toBe(original.agentId)
  const archive = f.daemon.client.archiveAgent
  const archived = vi.spyOn(f.daemon.client, 'archiveAgent').mockImplementation(async id => {
    const replacementId = f.daemon.creates.at(-1)?.agentId
    expect(replacementId).not.toBe(id)
    expect(f.daemon.snapshots.get(replacementId!)?.provider).toBe('codex')
    await archive(id)
    return { archivedAt: f.daemon.snapshots.get(id)!.archivedAt! }
  })
  const cancel = vi.spyOn(f.daemon.client, 'cancelAgent')
  f.daemon.status(original.agentId, 'idle')
  await f.adapter.reconcile()
  const current = f.adapter.binding(owner)
  expect(current.agentId).not.toBe(original.agentId)
  expect(current).toMatchObject({ provider: 'codex', profile: executorProfile })
  expect(f.daemon.archived).toEqual([original.agentId])
  expect(cancel).toHaveBeenCalledWith(original.agentId)
  expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(archived.mock.invocationCallOrder[0]!)
  expect(f.daemon.creates.at(-1)).toMatchObject({ provider: 'codex', model: executorProfile.model, title: '[project-a] dsh-superagent orchestrator',
    modeId: 'full-access', thinkingOptionId: 'medium', featureValues: { reasoning: true } })
  expect(f.adapter.binding(worker.owner)).toMatchObject({ agentId: firstWorker.agentId, provider: 'codex' })
  const secondWorker = await f.acceptedTicket()
  expect(f.adapter.binding(secondWorker.owner)).toMatchObject({ provider: 'pi', profile: assessorProfile })
  expect(f.daemon.creates.at(-1)).not.toHaveProperty('modeId')
  const { tools } = await (await f.rpc(secondWorker.owner, 'tools', {})).json() as { tools: { name: string }[] }
  expect(tools.filter(tool => tool.name.startsWith('orchestrator_'))).toHaveLength(6)
})

it('preserves the working Codex binding when Pi creation fails and recovers when Codex is saved again', async () => {
  const f = await open(), owner = f.runtime.masterId
  const save = (model: typeof assessorProfile) => f.runtime.settings.save('eval', { ...f.runtime.store.settings().eval, model },
    f.runtime.store.blockRevision('eval'), 'panel')
  await save(executorProfile)
  await vi.waitFor(() => expect(f.adapter.binding(owner).profile).toEqual(executorProfile))
  await vi.waitFor(() => expect(f.runtime.health.runtime?.state).toBe('ready'))
  const original = f.adapter.binding(owner), archive = vi.spyOn(f.daemon.client, 'archiveAgent'), cancel = vi.spyOn(f.daemon.client, 'cancelAgent')
  const create = f.daemon.client.createAgent
  vi.spyOn(f.daemon.client, 'createAgent').mockImplementation(input =>
    input.provider === 'pi' ? Promise.reject(new Error('Injected Pi creation failure')) : create(input))

  await save(assessorProfile)
  await vi.waitFor(() => expect(f.runtime.health.runtime).toMatchObject({ state: 'error', detail: expect.stringContaining(assessorProfile.name) }))
  await f.runtime.pump()
  expect(f.runtime.health.runtime?.state).toBe('error')
  expect(f.adapter.binding(owner).agentId).toBe(original.agentId)
  expect(f.adapter.link(owner)?.agentId).toBe(original.agentId)
  expect(cancel).not.toHaveBeenCalledWith(original.agentId)
  expect(archive).not.toHaveBeenCalledWith(original.agentId)
  expect((await f.rpc(owner, 'tools', {})).status).toBe(200)

  await save(executorProfile)
  await vi.waitFor(() => expect(f.runtime.health.runtime).toMatchObject({ state: 'ready' }))
  expect(f.adapter.binding(owner)).toMatchObject({ agentId: original.agentId, createdRemote: true, profile: executorProfile })
  expect(f.daemon.creates).toHaveLength(2)
  await f.adapter.agent(owner).steer({ id: 'profile-recovered', role: 'user', content: [{ type: 'text', text: 'Main session is usable' }],
    source: { kind: 'dsh-superagent', form: 'relay' } })
  expect(f.daemon.sent.at(-1)?.agentId).toBe(original.agentId)
})

it('keeps the current session when the selected Profile changes again during remote creation', async () => {
  const f = await open(), owner = f.runtime.masterId, original = f.adapter.binding(owner)
  const release = deferred(), create = f.daemon.client.createAgent
  const creating = vi.spyOn(f.daemon.client, 'createAgent').mockImplementation(async input => {
    await release.promise
    return create(input)
  })
  const save = (model: typeof assessorProfile) => f.runtime.settings.save('eval', { ...f.runtime.store.settings().eval, model },
    f.runtime.store.blockRevision('eval'), 'panel')
  try {
    await save(executorProfile)
    await vi.waitFor(() => expect(creating).toHaveBeenCalledOnce())
    expect(f.adapter.binding(owner).agentId).toBe(original.agentId)
    expect(f.daemon.archived).toEqual([])
    const reverting = track(save(assessorProfile))
    await vi.waitFor(() => expect(reverting.settled).toBe(true))
    await reverting.promise
  } finally { release.resolve() }

  await vi.waitFor(() => expect(f.daemon.archived).toEqual([f.daemon.creates[1]?.agentId]))
  expect(f.adapter.binding(owner)).toMatchObject({ agentId: original.agentId, profile: assessorProfile })
  expect(f.runtime.health.runtime?.state).toBe('ready')
})

it('checks historical pages beyond the daemon dedup window after a lost local receipt', async () => {
  let fail = true
  const f = await open({ afterRemoteSend: () => { if (fail) { fail = false; throw new Error('Lost local commit') } } }), owner = f.runtime.masterId
  const message = { id: 'older-message', role: 'user' as const, content: [{ type: 'text' as const, text: 'Historical unique input' }], source: { kind: 'dsh-superagent' } }
  await expect(f.adapter.agent(owner).steer(message)).rejects.toThrow('Lost local commit')
  const history = f.daemon.history.get(f.adapter.binding(owner).agentId)!
  for (let i = 0; i < 600; i++) history.push({ seqStart: history.length + 1, seqEnd: history.length + 1, item: { type: 'assistant_message', text: 'Later context' } })
  await f.adapter.agent(owner).steer(message)
  expect(f.daemon.sent.filter(row => row.text.includes('Historical unique input'))).toHaveLength(1)
  const transcript = await f.adapter.context.sessionController.inspect(owner)
  expect(transcript.events.filter(event => event.type === 'assistant/message')).toHaveLength(600)
})
it('drains nested descendants once each without racing two archives of the same child', async () => {
  const f = await open(), { owner } = await f.acceptedTicket()
  await f.adapter.createChild(f.adapter.binding(owner), { prompt: 'Child acceptance' })
  const child = f.adapter.children(owner)[0]!
  await f.adapter.createChild(child, { prompt: 'Grandchild acceptance' })
  const descendants = f.adapter.children(owner)
  const service = f.adapter.context.get('subagents') as { drainDescendants(parents: { id: string }[]): Promise<void> }
  await Promise.all([service.drainDescendants([{ id: owner }]), service.drainDescendants([{ id: owner }])])
  for (const descendant of descendants) {
    expect(f.adapter.binding(descendant.id).closed).toBe(true)
    expect(f.daemon.archived.filter(id => id === descendant.agentId)).toHaveLength(1)
  }
})
