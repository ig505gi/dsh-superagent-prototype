import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Engine, MemoryRepositories, key, type Candidate, type OutboundMessage, type Ticket } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { apply as applyDingtalk, dingtalkKind, dingtalkTrigger, pendingThread, receiveDingtalk, sendDingtalk } from '../src/sources/dingtalk.ts'
import { gitlabKind, pollGitlab, pollMr } from '../src/sources/gitlab.ts'
import { claimMr, mrEndNotices, type GitlabMr } from '../src/sources/gitlab-mr.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { resolveGitlab } from '../src/deployment.ts'
import { composePrompt, defaultPrompts } from '../src/app/prompts.ts'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { trashSync } from './fixtures/trash.ts'

const message = (id: string, overrides: Record<string, unknown> = {}) => ({ msgId: id, conversationId: 'cid-group', conversationType: '2' as const,
  senderStaffId: 'alice', senderNick: 'Alice', robotCode: 'bot', createAt: 1_760_000_000_000, msgtype: 'text' as const,
  text: { content: 'Change the button' }, isInAtList: true, ...overrides })
const mr = (overrides: Partial<GitlabMr> = {}): GitlabMr => ({ iid: 7, title: 'Change the button', state: 'opened',
  web_url: 'https://gitlab.example.com/team/app/-/merge_requests/7', author: { username: 'agent' }, source_branch: 'agent/change',
  source_project_id: 3, target_project_id: 3, sha: 'head-1', head_pipeline: { id: 5, sha: 'head-1', status: 'running' }, ...overrides })

function harness() {
  const repo = new MemoryRepositories(), outgoing: OutboundMessage[] = [], candidates: Candidate[] = []
  const settings = SettingsSchema.parse({ sources: { dingtalk: { enabled: true, config: { groups: [{ id: 'cid-group' }] } },
    gitlab: { enabled: true, config: { host: 'gitlab.example.com', project: 'team/app', cli: 'glab' } } },
    policy: { sources: { dingtalk: { allowed: [{ id: 'alice' }] } } } })
  const sources = new SourceRegistry(() => settings)
  sources.register(dingtalkKind); sources.register(gitlabKind)
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
    assessor: { request: candidate => { candidates.push(candidate) }, release: () => {} }, executor,
    outbox: { send: item => outgoing.push(item), status: () => undefined, withdraw: () => {} },
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'change', directory: '/tmp/ticket', assignment: '' } }) })
  const deployment = testDeployment({ repository: 'team/app', forge: { kind: 'gitlab', host: 'gitlab.example.com', cli: 'glab', login: 'agent', noreply: 'agent@example.com' } })
  const state = new Map<string, unknown>()
  const run = vi.fn(async () => JSON.stringify(mr()))
  const commands = { run, withSignal() { return this } }
  const patchThread = (threadKey: string, meta: Record<string, unknown>) => {
    const thread = repo.threads.get(threadKey)
    if (thread) { thread.meta = { ...thread.meta, ...meta }; repo.threads.save(thread) }
  }
  const ctx = { deployment, commands, ready: Promise.resolve(), configured: () => true,
    config: (kind: string) => sources.instance(kind)?.config, receive: (trigger: Parameters<Engine['receive']>[0]) => engine.receive(trigger),
    atomic: <T>(work: () => T) => repo.atomic(work),
    state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => { state.set(name, value) }, keys: () => [] },
    tickets: { get: repo.tickets.get, open: repo.tickets.open, bindThread: (id: string, ref: { source: string; id: string }, own: boolean) => { engine.bindThread(id, ref, own) },
      threadClosed: (ref: { source: string; id: string }, outcome: 'merged' | 'closed', at: string) => { engine.threadClosed(ref, outcome, at) } },
    threads: { get: repo.threads.get, subscribed: () => repo.threads.list(), patch: patchThread,
      describe: (id: string, value: unknown) => patchThread(id, { description: value }) },
    triggers: { get: repo.triggers.get, latest: () => undefined }, notify: () => {}, report: () => {} } as unknown as SourceContext
  const accept = async () => {
    await receiveDingtalk(ctx, message('first'))
    engine.evaluateDue()
    const candidate = candidates.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', evalId: candidate.evalId, title: 'Change', scope: 'Change', reason: 'requested' })
    const ticket = repo.tickets.get(decision.ticketId!)!
    engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    return repo.tickets.get(ticket.id)!
  }
  return { repo, engine, ctx, state, run, outgoing, executor, accept }
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('DingTalk intake', () => {
  beforeEach(() => {
    for (const key of ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_ID_FILE', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_CLIENT_SECRET_FILE']) {
      vi.stubEnv(key, undefined)
    }
  })

  it('registers the Stream callback, acknowledges intake and reconnects after a disconnect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dingtalk-credentials-'))
    onTestFinished(() => trashSync(dir))
    const idFile = join(dir, 'id'), secretFile = join(dir, 'secret')
    await Promise.all([writeFile(idFile, 'test-app\n', { mode: 0o600 }), writeFile(secretFile, 'test-secret\r\n', { mode: 0o600 })])
    vi.stubEnv('DINGTALK_CLIENT_ID_FILE', idFile)
    vi.stubEnv('DINGTALK_CLIENT_SECRET_FILE', secretFile)
    const clients: DWClient[] = []
    const connect = vi.spyOn(DWClient.prototype, 'connect').mockImplementation(async function (this: DWClient) { clients.push(this); this.connected = true })
    vi.spyOn(DWClient.prototype, 'disconnect').mockImplementation(function (this: DWClient) { this.connected = false })
    const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
    const h = harness(), disposers: (() => unknown)[] = []
    const host = { sources: { register: () => () => {} }, context: () => h.ctx }
    applyDingtalk({ orchestrator: host, effect: (work: () => () => unknown) => { disposers.push(work()) } } as never)
    try {
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
      const first = clients[0]!
      expect(first.config).toMatchObject({ clientId: 'test-app', clientSecret: 'test-secret' })
      first.emit(TOPIC_ROBOT, { headers: { messageId: 'delivery-1' }, data: JSON.stringify(message('stream')) })
      await vi.waitFor(() => expect(ack).toHaveBeenCalledWith('delivery-1', null))
      expect(h.repo.triggers.get(key('dingtalk', 'cid-group', 'stream'))).toBeDefined()
      first.connected = false
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2), { timeout: 7000 })
    } finally { await disposers[1]!() }
  }, 10000)
  it.each(['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'])('rejects conflicting sources for %s before opening a Stream or sending', async name => {
    vi.stubEnv(name, 'synthetic-credential')
    vi.stubEnv(`${name}_FILE`, '/example/credential')
    const detail = `Set only one of ${name} and ${name}_FILE`
    const connect = vi.spyOn(DWClient.prototype, 'connect').mockResolvedValue()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const h = harness(), report = vi.spyOn(h.ctx, 'report'), disposers: (() => unknown)[] = []
    const host = { sources: { register: () => () => {} }, context: () => h.ctx }
    applyDingtalk({ orchestrator: host, effect: (work: () => () => unknown) => { disposers.push(work()) } } as never)
    try {
      await vi.waitFor(() => expect(report).toHaveBeenCalledWith('dingtalk', { state: 'error', detail }))
      const trigger = dingtalkTrigger(message('first'))
      await expect(sendDingtalk({} as never, { id: 'out-1', channel: trigger.channel!, text: 'Done', kind: 'reply' })).rejects.toThrow(detail)
      expect(connect).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await disposers[1]!() }
  })
  it('requires an absolute readable credential file and omits its path from errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dingtalk-credentials-'))
    onTestFinished(() => trashSync(dir))
    const trigger = dingtalkTrigger(message('first'))
    const send = () => sendDingtalk({} as never, { id: 'out-1', channel: trigger.channel!, text: 'Done', kind: 'reply' })
    vi.stubEnv('DINGTALK_CLIENT_ID', 'test-app')
    vi.stubEnv('DINGTALK_CLIENT_SECRET_FILE', 'relative')
    await expect(send()).rejects.toThrow(/^DINGTALK_CLIENT_SECRET_FILE must be an absolute path$/)
    vi.stubEnv('DINGTALK_CLIENT_SECRET_FILE', join(dir, 'missing'))
    await expect(send()).rejects.toThrow(/^Cannot read DINGTALK_CLIENT_SECRET_FILE$/)
  })
  it('creates a ticket, routes its question to the original group and delivers the answer to that ticket', async () => {
    const h = harness(), ticket = await h.accept()
    h.engine.report(ticket.id, { state: 'blocked', summary: 'Need a decision', question: 'Choose A or B' })
    h.engine.reply({ ticketId: ticket.id, purpose: 'attention', question: 'Choose A or B', text: 'Choose A or B' })
    expect(h.outgoing.at(-1)?.channel.address).toEqual({ conversationId: 'cid-group', robotCode: 'bot' })
    await receiveDingtalk(h.ctx, message('answer', { text: { content: `工单 ${ticket.id.slice(0, 8)} 选 A` } }))
    const answer = h.repo.triggers.get(key('dingtalk', 'cid-group', 'answer'))!
    expect(h.repo.triggers.disposition(answer.id)?.fanout).toEqual([ticket.id])
    expect(answer.threads).toEqual(h.repo.triggers.get(ticket.origin.triggerId)!.threads)
    expect(h.executor.deliver).toHaveBeenCalled()
    expect(h.engine.receive(answer)).toBe('duplicate')
  })
  it('routes only an explicitly identified answer, even with one pending question', async () => {
    const h = harness(), ticket = await h.accept()
    h.engine.report(ticket.id, { state: 'blocked', summary: 'Need a decision', question: 'Choose A or B' })
    expect(pendingThread(h.ctx, message('next', { senderStaffId: 'bob' }))).toBeUndefined()
    expect(pendingThread(h.ctx, message('next', { senderStaffId: 'bob', text: { content: `工单 ${ticket.id.slice(0, 8)} 选 A` } })))
      .toEqual(h.repo.triggers.get(ticket.origin.triggerId)!.threads[0])
    h.repo.tickets.save({ ...h.repo.tickets.get(ticket.id)!, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(pendingThread(h.ctx, message('next'))).toBeUndefined()
    expect(pendingThread(h.ctx, message('selected', { text: { content: `工单 ${ticket.id.slice(0, 8)} 选 A` } })))
      .toEqual(h.repo.triggers.get(ticket.origin.triggerId)!.threads[0])
    expect(dingtalkTrigger(message('next')).threads[0]!.id).toBe('cid-group:next')
  })
  it('filters other groups and ignores non-text or non-mentioned callbacks', async () => {
    const h = harness()
    const receive = vi.spyOn(h.ctx, 'receive')
    await receiveDingtalk(h.ctx, message('other', { conversationId: 'cid-other' }))
    expect(receive).not.toHaveBeenCalled()
    expect(h.repo.triggers.get(key('dingtalk', 'cid-other', 'other'))).toBeUndefined()
    expect(h.repo.triggers.disposition(key('dingtalk', 'cid-other', 'other'))).toBeUndefined()
    await receiveDingtalk(h.ctx, message('not-mentioned', { isInAtList: false }))
    await receiveDingtalk(h.ctx, message('mention-unknown', { isInAtList: undefined }))
    await receiveDingtalk(h.ctx, message('image', { msgtype: 'picture' }))
    expect(h.repo.triggers.get(key('dingtalk', 'cid-group', 'not-mentioned'))).toBeUndefined()
    expect(h.repo.triggers.get(key('dingtalk', 'cid-group', 'mention-unknown'))).toBeUndefined()
    expect(h.repo.triggers.get(key('dingtalk', 'cid-group', 'image'))).toBeUndefined()
  })
  it('recognizes an @ mention from the bot identity when isInAtList is absent', async () => {
    const h = harness()
    await receiveDingtalk(h.ctx, message('at-user', { isInAtList: undefined, chatbotUserId: 'bot-user', atUsers: [{ dingtalkId: 'bot-user' }] }))
    expect(h.repo.triggers.get(key('dingtalk', 'cid-group', 'at-user'))).toBeDefined()
  })
  it('sends a long-running ticket result with the application bot, without storing a temporary webhook', async () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'test-app')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'test-secret')
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'test-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ processQueryKey: 'sent' })))
    vi.stubGlobal('fetch', fetchMock)
    const trigger = dingtalkTrigger(message('first'))
    const sent = await sendDingtalk({} as never, { id: 'out-1', channel: trigger.channel!, text: 'Done', kind: 'reply',
      ticketId: '12345678aaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(sent).toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toMatchObject({ openConversationId: 'cid-group', robotCode: 'bot', msgKey: 'sampleMarkdown' })
    expect(JSON.parse(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).msgParam).text).toContain('工单 12345678')
    expect(JSON.stringify(trigger)).not.toContain('test-secret')
    expect(JSON.stringify(trigger)).not.toContain('sessionWebhook')
  })
  it('does not treat a malformed bot send response as a successful delivery', async () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'test-app'); vi.stubEnv('DINGTALK_CLIENT_SECRET', 'test-secret')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'test-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not sent' }))))
    const trigger = dingtalkTrigger(message('first'))
    await expect(sendDingtalk({} as never, { id: 'out-1', channel: trigger.channel!, text: 'Done', kind: 'reply' })).rejects.toThrow()
  })
})

describe('GitLab ticket MR and CI', () => {
  it('uses the configured instance for both setup probes', async () => {
    const probe = vi.fn(async (argv: string[]) => argv[2] === 'user'
      ? JSON.stringify({ id: 1, username: 'agent' })
      : JSON.stringify({ path_with_namespace: 'team/app', permissions: { project_access: { access_level: 30 } } }))
    await resolveGitlab(testDeployment(), { host: 'gitlab.example.com:8443', project: 'team/app', cli: '/usr/bin/true' }, probe)
    expect(probe.mock.calls.map(([argv]) => argv.slice(1))).toEqual([
      ['api', 'user', '--hostname', 'gitlab.example.com:8443'],
      ['api', 'projects/team%2Fapp', '--hostname', 'gitlab.example.com:8443'],
    ])
  })
  it('uses the GitLab worker and delivery instructions without GitHub auto-merge instructions', () => {
    const prompt = composePrompt(defaultPrompts(), 'worker', undefined, undefined, 'gitlab')
    expect(prompt).toContain('Use glab for GitLab operations')
    expect(prompt).toContain('enable GitLab auto-merge')
    expect(prompt).not.toContain('Never enable auto-merge as the agent account')
    expect(prompt).not.toContain('Use gh for ALL GitHub operations')
    expect(prompt).toContain('GitLab review comments are not automatically collected')
    expect(prompt).toContain('Report the MR IID immediately')
    expect(prompt).not.toContain('CLI Markdown-to-rich-text transport')
    expect(defaultPrompts('gitlab').delivery).toContain('GitLab auto-merge')
  })
  it('binds only the agent MR on this ticket branch and observes CI then merge', async () => {
    const h = harness(), ticket = await h.accept()
    expect(claimMr(h.ctx, ticket.id, mr({ source_branch: 'agent/other' }))).toContain('ticket branch')
    expect(claimMr(h.ctx, ticket.id, mr({ source_project_id: 9 }))).toContain('project')
    expect(claimMr(h.ctx, ticket.id, mr())).toBeUndefined()
    expect(h.repo.tickets.get(ticket.id)?.follows).toMatchObject([{ thread: 'gitlab:mr:7', own: true }])
    await pollMr(h.ctx, mr())
    await pollMr(h.ctx, mr({ head_pipeline: { id: 5, sha: 'head-1', status: 'failed' } }))
    const failed = [...h.state.entries()].find(([key]) => key === 'gitlab-ci:7')?.[1]
    expect(failed).toMatchObject({ revision: 1 })
    expect(h.repo.triggers.get(key('gitlab-pipeline', 'mr', '7', '1'))?.text).toContain('failed')
    h.engine.report(ticket.id, { state: 'ready', summary: 'Ready' })
    await pollMr(h.ctx, mr({ state: 'merged', merged_at: new Date(Date.now() + 60_000).toISOString() }))
    const ended = h.repo.tickets.get(ticket.id)!
    expect(ended.ended?.outcome).toBe('merged')
    expect(mrEndNotices(ended, '修改按钮', 'gitlab.example.com', 'team/app')[0]?.text).toContain('已合并')
  })
  it('does not call an old pipeline for another head successful', async () => {
    const h = harness(), ticket = await h.accept()
    claimMr(h.ctx, ticket.id, mr())
    await pollMr(h.ctx, mr({ sha: 'new-head', head_pipeline: { id: 6, sha: 'old-head', status: 'success' } }))
    const thread = h.repo.threads.get('gitlab:mr:7')!
    expect(JSON.stringify(thread.meta)).toContain('unknown')
    expect(JSON.stringify(thread.meta)).not.toContain('success')
  })
  it('polls only merge requests bound to open tickets on the configured host', async () => {
    const h = harness(), ticket = await h.accept()
    claimMr(h.ctx, ticket.id, mr())
    await pollGitlab(h.ctx)
    expect(h.run).toHaveBeenCalledWith('glab', ['api', 'projects/team%2Fapp/merge_requests/7', '--hostname', 'gitlab.example.com'])
  })
})
