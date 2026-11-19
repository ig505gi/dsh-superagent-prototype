import { appendFile, mkdir, mkdtemp, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, key, type Candidate, type OutboundMessage, type ReceiveResult, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { apply, conversationMessage, notifyPaseoQuestions, paseoChannel, paseoKind, pollSession, receivePaseo, resolveSession } from '../src/sources/paseo.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { triggerMessage } from '../src/executor/paseo.ts'

const agentId = 'd070f3ad-19fa-4af3-a3f0-479ef668bc66', sessionId = '01a1afa8-27f4-7840-b65d-a427d651c4eb'
const at = '2026-11-06T07:00:00.000Z'
const record = (role: 'user' | 'assistant', id: string, text: string, fields: Record<string, unknown> = {}) => JSON.stringify({
  type: 'response_item', timestamp: at, payload: { type: 'message', role, id,
    ...(role === 'user' ? { internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } : { phase: 'final_answer' }),
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...fields },
})

function ticketHarness() {
  const repo = new MemoryRepositories(), candidates: Candidate[] = [], outgoing = new Map<string, OutboundMessage>()
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' },
    sources: { paseo: { enabled: true, config: { sessions: [{ id: agentId }] } } },
    policy: { sources: { paseo: { allowed: [{ id: 'operator' }] } } } })
  const sources = new SourceRegistry(() => settings); sources.register(paseoKind)
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const notify = (item: OutboundMessage) => { if (!outgoing.has(item.id)) outgoing.set(item.id, item) }
  const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources), executor,
    assessor: { request: candidate => { candidates.push(candidate) } },
    outbox: { send: notify, status: id => outgoing.has(id) ? 'pending' : undefined, withdraw: id => { outgoing.delete(id) } } })
  const ctx = { config: () => sources.instance('paseo')?.enabled ? sources.instance('paseo')?.config : undefined,
    receive: (trigger: Trigger) => engine.receive(trigger), notify,
    tickets: { open: repo.tickets.open, get: repo.tickets.get, bindChannel: (id: string, channel: Parameters<Engine['bindChannel']>[1]) => { engine.bindChannel(id, channel) } },
    triggers: { get: repo.triggers.get }, threads: { get: repo.threads.get } } as unknown as SourceContext
  const human = (id: string, text: string) => ({ id, from: 'operator', at, text })
  const accept = async (id = 'first', selectedAgent = agentId) => {
    // A second configured conversation is used only for destination-isolation tests.
    const config = settings.sources.paseo!.config as { sessions: { id: string }[] }
    if (!config.sessions.some(item => item.id === selectedAgent)) {
      config.sessions.push({ id: selectedAgent })
    }
    await receivePaseo(ctx, selectedAgent, human(id, 'Please implement the agreed change'), [])
    engine.evaluateDue()
    const candidate = candidates.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', evalId: candidate.evalId,
      title: 'Implement confirmed change', scope: 'confirmed scope', reason: 'confirmed', rules: ['copy'] })
    const ticket = repo.tickets.get(decision.ticketId!)!
    engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    engine.report(ticket.id, { state: 'blocked', summary: 'Needs a business decision', question: 'Choose A or B' })
    return repo.tickets.get(ticket.id)!
  }
  return { repo, sources, settings, engine, executor, candidates, outgoing, ctx, human, accept }
}

describe('Paseo ticket questions and answers', () => {
  it('queues one question, sends a numbered answer to the original worker and creates no second ticket', async () => {
    const h = ticketHarness(), ticket = await h.accept()
    notifyPaseoQuestions(h.ctx); notifyPaseoQuestions(h.ctx)
    expect(h.outgoing.size).toBe(1)
    expect([...h.outgoing.values()][0]).toMatchObject({ id: key('attention-reply', ticket.attention!.id),
      channel: paseoChannel(agentId), ticketId: ticket.id, text: expect.stringContaining('Choose A or B') })
    const answer = h.human('answer', `回复工单 ${ticket.id.slice(0, 8)}：选择 A`)
    await receivePaseo(h.ctx, agentId, answer, [])
    await receivePaseo(h.ctx, agentId, answer, [])
    h.engine.evaluateDue()
    const saved = h.repo.triggers.get(key('paseo', agentId, answer.id))!
    expect(saved.text).toBe(answer.text)
    expect(saved.threads).toEqual(h.repo.triggers.get(ticket.origin.triggerId)!.threads)
    expect(h.repo.triggers.disposition(saved.id)?.fanout).toEqual([ticket.id])
    expect(triggerMessage(saved, {})).toMatchObject({ answering: { ticket_id: ticket.id, question: 'Choose A or B' }, reply_available: true })
    expect(h.executor.deliver).toHaveBeenCalled()
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(h.candidates).toHaveLength(1)
    expect(h.repo.tickets.get(ticket.id)!.inputs.filter(item => item.kind === 'trigger' && item.triggerId === saved.id)).toHaveLength(1)
    h.engine.report(ticket.id, { state: 'progress', summary: 'Continuing with A', question: null })
    expect(h.repo.tickets.get(ticket.id)!.attention).toBeUndefined()
  })

  it('recovers a pre-upgrade ticket channel and question without restarting its assignment or changing its mandate', async () => {
    const h = ticketHarness(), ticket = await h.accept(), origin = h.repo.triggers.get(ticket.origin.triggerId)!
    delete origin.channel; h.repo.triggers.save(origin)
    h.repo.tickets.save({ ...ticket, channels: [] })
    h.executor.start.mockClear(); h.executor.deliver.mockClear()
    notifyPaseoQuestions(h.ctx)
    const restored = h.repo.tickets.get(ticket.id)!
    expect(restored.channels).toEqual([paseoChannel(agentId)])
    expect(h.repo.triggers.get(origin.id)!.channel).toEqual(paseoChannel(agentId))
    expect(restored.mandate).toEqual(ticket.mandate)
    expect(restored.assignments).toEqual(ticket.assignments)
    expect(h.executor.start).not.toHaveBeenCalled(); expect(h.executor.deliver).not.toHaveBeenCalled()
    expect(h.outgoing.size).toBe(1)
    h.engine.report(ticket.id, { state: 'ready', summary: 'Done' })
    h.engine.reply({ purpose: 'result', ticketId: ticket.id, text: 'Done' })
    expect([...h.outgoing.values()].at(-1)?.channel).toEqual(paseoChannel(agentId))
  })

  it('selects the numbered question when two tickets are waiting and preserves unnumbered conversation as new intake', async () => {
    const h = ticketHarness(), first = await h.accept('first'), second = await h.accept('second')
    await receivePaseo(h.ctx, agentId, h.human('answer', `回复工单 ${second.id.slice(0, 8)}：B`), [])
    const saved = h.repo.triggers.get(key('paseo', agentId, 'answer'))!
    expect(h.repo.triggers.disposition(saved.id)?.fanout).toEqual([second.id])
    expect(h.repo.tickets.get(first.id)!.undelivered).toEqual([])
    await receivePaseo(h.ctx, agentId, h.human('discussion', 'What about another feature?'), [])
    expect(h.repo.triggers.disposition(key('paseo', agentId, 'discussion'))?.fanout).toEqual([])
    expect(h.repo.tickets.list()).toHaveLength(2)
  })

  it('refuses wrong, malformed, ended and cross-conversation references without new work', async () => {
    const h = ticketHarness(), ticket = await h.accept()
    const otherAgent = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    for (const [id, selectedAgent, text] of [
      ['wrong', agentId, '回复工单 deadbeef：A'],
      ['malformed', agentId, `回复工单 ${ticket.id.slice(0, 8)}`],
      ['other-session', otherAgent, `回复工单 ${ticket.id.slice(0, 8)}：A`],
    ]) await receivePaseo(h.ctx, selectedAgent!, h.human(id!, text!), [])
    h.engine.stopTicket(ticket.id)
    await receivePaseo(h.ctx, agentId, h.human('ended', `回复工单 ${ticket.id.slice(0, 8)}：A`), [])
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(h.repo.triggers.get(key('paseo', agentId, 'wrong'))).toBeUndefined()
    expect([...h.outgoing.values()].filter(item => item.text.includes('答案未转交'))).toHaveLength(4)
    expect(h.executor.deliver).not.toHaveBeenCalled()
  })

  it('withdraws replaced questions and stops notifications after source deselection', async () => {
    const h = ticketHarness(), ticket = await h.accept()
    notifyPaseoQuestions(h.ctx)
    h.engine.report(ticket.id, { state: 'blocked', summary: 'Different question', question: 'Choose C or D' })
    notifyPaseoQuestions(h.ctx)
    expect(h.outgoing.size).toBe(1)
    expect([...h.outgoing.values()][0]!.text).toContain('Choose C or D')
    h.settings.sources.paseo!.enabled = false
    h.outgoing.clear()
    notifyPaseoQuestions(h.ctx)
    expect(h.outgoing.size).toBe(0)
  })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-paseo-test-'))
  const paseo = join(root, '.paseo'), codex = join(root, '.codex')
  await mkdir(join(paseo, 'agents', 'project'), { recursive: true })
  await mkdir(join(codex, 'sessions', '2026', '11', '06'), { recursive: true })
  await writeFile(join(paseo, 'agents', 'project', `${agentId}.json`), JSON.stringify({ id: agentId, provider: 'codex',
    persistence: { provider: 'codex', sessionId } }))
  const file = join(codex, 'sessions', '2026', '11', '06', `rollout-2026-11-06T14-59-55-${sessionId}.jsonl`)
  await writeFile(file, `${record('user', 'old', 'old conversation')}\n${record('assistant', 'old-answer', 'the previous answer')}\n`)
  const state = new Map<string, unknown>(), received: Trigger[] = []
  let selected = true
  const receive = vi.fn(async (trigger: Trigger): Promise<ReceiveResult> => { received.push(trigger); return 'stored' })
  const ctx = { state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => state.set(name, value),
    keys: (family: { prefix: string }) => [...state.keys()].filter(name => name.startsWith(family.prefix)) },
    ready: Promise.resolve(), configured: () => true, report: vi.fn(),
    config: () => selected ? { sessions: [{ id: agentId }] } : { sessions: [] }, receive,
    tickets: { open: () => [] } } as unknown as SourceContext
  return { root, paseo, codex, file, state, received, receive, ctx, deselect: () => { selected = false } }
}

describe('Paseo Codex intake', () => {
  it('registers the Source and watches a selected session until disposed', async () => {
    const f = await fixture(), disposers: (() => unknown)[] = []
    vi.stubEnv('HOME', f.root); vi.stubEnv('CODEX_HOME', f.codex)
    const register = vi.fn(() => () => {})
    apply({ orchestrator: { sources: { register }, context: () => f.ctx },
      effect: (work: () => () => unknown) => { disposers.push(work()) } } as never)
    try {
      await vi.waitFor(() => expect(f.ctx.report).toHaveBeenCalledWith('paseo', expect.objectContaining({ state: 'ready' })))
      expect(register).toHaveBeenCalledWith(paseoKind)
      await appendFile(f.file, `${record('user', 'live', 'new request')}\n`)
      await vi.waitFor(() => expect(f.received.map(trigger => trigger.text)).toEqual(['new request']), { timeout: 4000 })
    } finally {
      await disposers[1]!(); vi.unstubAllEnvs()
    }
  })
  it('resolves only a selected Codex agent and rejects other providers', async () => {
    const f = await fixture()
    expect(await resolveSession(agentId, f.paseo, f.codex)).toEqual({ sessionId, file: f.file })
    await writeFile(join(f.paseo, 'agents', 'project', `${agentId}.json`), JSON.stringify({ id: agentId, provider: 'pi' }))
    await expect(resolveSession(agentId, f.paseo, f.codex)).rejects.toThrow('no local Codex session')
    await expect(resolveSession('../bad', f.paseo, f.codex)).rejects.toThrow('Invalid Paseo agent ID')
  })

  it('filters injected instructions, reasoning, tools and non-final assistant text', () => {
    expect(conversationMessage(record('user', '1', 'hello'))).toMatchObject({ id: '1', from: 'operator', text: 'hello' })
    expect(conversationMessage(record('assistant', '2', 'answer'))).toMatchObject({ bot: true, text: 'answer' })
    expect(conversationMessage(record('user', '3', 'injected', { internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] } }))).toBeUndefined()
    expect(conversationMessage(record('assistant', '4', 'progress', { phase: 'commentary' }))).toBeUndefined()
    expect(conversationMessage(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'secret' } }))).toBeUndefined()
    expect(conversationMessage('null')).toBeUndefined()
    expect(conversationMessage(record('user', '5', 'bad', { content: [null] }))).toBeUndefined()
  })

  it('starts at the end, retains bounded conversation, and consumes a new complete human message only once', async () => {
    const f = await fixture(), resolved = await resolveSession(agentId, f.paseo, f.codex)
    await pollSession(f.ctx, agentId, resolved)
    expect(f.received).toHaveLength(0)
    await appendFile(f.file, `${record('assistant', 'comment', 'internal', { phase: 'commentary' })}\n${record('user', 'new', 'Please implement the agreed change')}\n`)
    await pollSession(f.ctx, agentId, resolved)
    await pollSession(f.ctx, agentId, resolved)
    expect(f.received).toHaveLength(1)
    expect(f.received[0]).toMatchObject({ id: key('paseo', agentId, 'new'), human: true, text: 'Please implement the agreed change',
      meta: { agentId, messageId: 'new', context: [{ id: 'old' }, { id: 'old-answer', bot: true }] } })
    expect(f.received[0]!.addressed).toBeUndefined()
    expect(f.received[0]!.channel).toEqual(paseoChannel(agentId))
    expect(triggerMessage(f.received[0]!, {})).toMatchObject({ reply_available: true, conversation: [{ id: 'old' }, { id: 'old-answer' }] })
    const context = await paseoKind.threadContext!.read({} as never, f.received[0]!, 'thread', undefined, { sessions: [{ id: agentId }] })
    expect(context.messages.map(message => message.id)).toEqual(['old', 'old-answer', 'new'])
    expect(await paseoKind.threadContext!.read({} as never, f.received[0]!, 'parent', undefined, { sessions: [{ id: agentId }] }))
      .toMatchObject({ messages: [], status: 'not_available' })
  })

  it('waits for a complete line, resumes after receive failure, and stops after deselection', async () => {
    const f = await fixture(), resolved = await resolveSession(agentId, f.paseo, f.codex)
    await pollSession(f.ctx, agentId, resolved)
    const line = record('user', 'new', 'do this')
    await appendFile(f.file, line.slice(0, 30))
    await pollSession(f.ctx, agentId, resolved)
    expect(f.receive).not.toHaveBeenCalled()
    await appendFile(f.file, `${line.slice(30)}\n`)
    f.receive.mockRejectedValueOnce(new Error('unavailable'))
    await expect(pollSession(f.ctx, agentId, resolved)).rejects.toThrow('unavailable')
    await pollSession(f.ctx, agentId, resolved)
    expect(f.received).toHaveLength(1)
    await appendFile(f.file, `${record('user', 'later', 'other')}\n`)
    f.deselect()
    await pollSession(f.ctx, agentId, resolved)
    expect(f.received).toHaveLength(1)
  })

  it('does not replay a line that was already partial when observation started', async () => {
    const f = await fixture(), resolved = await resolveSession(agentId, f.paseo, f.codex)
    const old = record('user', 'partial-old', 'old request')
    await appendFile(f.file, old.slice(0, 25))
    await pollSession(f.ctx, agentId, resolved)
    await appendFile(f.file, `${old.slice(25)}\n${record('user', 'new', 'new request')}\n`)
    await pollSession(f.ctx, agentId, resolved)
    expect(f.received.map(trigger => trigger.text)).toEqual(['new request'])
  })

  it('skips oversized tool records without blocking the next user message', async () => {
    const f = await fixture(), resolved = await resolveSession(agentId, f.paseo, f.codex)
    await pollSession(f.ctx, agentId, resolved)
    await appendFile(f.file, `${JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x'.repeat(4 * 1024 * 1024) } })}\n${record('user', 'new', 'new request')}\n`)
    await pollSession(f.ctx, agentId, resolved)
    await pollSession(f.ctx, agentId, resolved)
    expect(f.received.map(trigger => trigger.text)).toEqual(['new request'])
  })

  it('does not replay a replaced or truncated rollout', async () => {
    const f = await fixture(), resolved = await resolveSession(agentId, f.paseo, f.codex)
    await pollSession(f.ctx, agentId, resolved)
    await truncate(f.file, 0)
    await expect(pollSession(f.ctx, agentId, resolved)).rejects.toThrow('truncated')
    expect(f.received).toHaveLength(0)
  })

  it('feeds unaddressed messages into existing policy as inferred candidates', async () => {
    const f = await fixture(), resolved = await resolveSession(agentId, f.paseo, f.codex)
    const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, sources: { paseo: { enabled: true, config: { sessions: [{ id: agentId }] } } },
      policy: { sources: { paseo: { allowed: [{ id: 'operator' }] } } } })
    const sources = new SourceRegistry(() => settings); sources.register(paseoKind)
    const repo = new MemoryRepositories(), candidates: Candidate[] = []
    const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
      assessor: { request: candidate => { candidates.push(candidate) } }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
    f.receive.mockImplementation(async trigger => engine.receive(trigger))
    await pollSession(f.ctx, agentId, resolved)
    await appendFile(f.file, `${record('user', 'candidate', 'Please fix the button wording')}\n`)
    await pollSession(f.ctx, agentId, resolved)
    engine.evaluateDue()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ strength: 'inferred', triggers: [{ text: 'Please fix the button wording' }] })
    const candidate = candidates[0]!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', evalId: candidate.evalId, title: 'Fix wording', scope: 'button', reason: 'matches', rules: ['copy'] })
    expect(decision.kind).toBe('accept')
    expect(repo.tickets.get(decision.ticketId!)?.origin.triggerId).toBe(candidate.triggers[0]!.id)
  })
})
