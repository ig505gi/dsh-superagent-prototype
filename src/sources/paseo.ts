/** Local Paseo Codex conversations, ticket notifications and explicitly numbered answers. */
import type { Context } from '../runtime/context.ts'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { ContextMessage, SourceKind } from './kind.ts'
import { isPaseoNotification, PASEO_AGENT_ID, sendPaseo } from './paseo-channel.ts'

const SOURCE = 'paseo', OPERATOR = 'operator', CONTEXT_COUNT = 8, CONTEXT_CHARS = 400
const READ_LIMIT = 4 * 1024 * 1024
const UUID = PASEO_AGENT_ID
const ConfigSchema = z.object({ sessions: z.array(z.object({ id: z.string().regex(UUID).toLowerCase(), name: z.string().trim().max(100).optional() }).strict())
  .refine(items => new Set(items.map(item => item.id.toLowerCase())).size === items.length, 'Duplicate session IDs').default([]) }).strict()
export type PaseoConfig = z.infer<typeof ConfigSchema>
type ChatMessage = ContextMessage
interface Cursor { sessionId: string; file: string; dev: number; ino: number; offset: number; discard: boolean; context: ChatMessage[] }
const cursorKey = family<Cursor, [agentId: string]>('paseo-cursor:')

/** Only Codex response messages authored by a user or a final assistant response become conversation context. */
export function conversationMessage(line: string): ChatMessage | undefined {
  let record: { type?: string; timestamp?: string; payload?: { type?: string; role?: string; id?: string; phase?: string;
    internal_chat_message_metadata_passthrough?: { content_item_kinds?: string[] }; content?: { type?: string; text?: string }[] } }
  try { record = JSON.parse(line) } catch { return undefined }
  if (!record || typeof record !== 'object') return
  const item = record.payload
  if (record.type !== 'response_item' || item?.type !== 'message' || typeof item.id !== 'string' || !item.id
    || typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp)) || !Array.isArray(item.content)) return
  const user = item.role === 'user' && JSON.stringify(item.internal_chat_message_metadata_passthrough?.content_item_kinds) === '["user.text"]'
  const assistant = item.role === 'assistant' && item.phase === 'final_answer'
  if (!user && !assistant) return
  const text = item.content.filter(part => part && typeof part === 'object' && part.type === (user ? 'input_text' : 'output_text') && typeof part.text === 'string')
    .map(part => part.text!).join('\n').trim()
  if (!text || isPaseoNotification(text)) return
  return { id: item.id, from: user ? OPERATOR : 'assistant', at: record.timestamp, text, ...assistant ? { bot: true as const } : {} }
}
const summary = (message: ChatMessage): ChatMessage => ({ ...message, text: message.text.slice(0, CONTEXT_CHARS) })
const remember = (messages: ChatMessage[], message: ChatMessage): ChatMessage[] => [...messages, summary(message)].slice(-CONTEXT_COUNT)

/** Resolve only the selected local agent's persisted metadata, then locate its Codex rollout by native session ID. */
export async function resolveSession(agentId: string, paseoHome = join(homedir(), '.paseo'), codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')):
Promise<{ sessionId: string; file: string }> {
  if (!UUID.test(agentId)) throw new Error('Invalid Paseo agent ID')
  const root = join(paseoHome, 'agents')
  const dirs = await readdir(root, { withFileTypes: true })
  const matches: string[] = []
  for (const dir of dirs) if (dir.isDirectory()) {
    const file = join(root, dir.name, `${agentId}.json`)
    try { await stat(file); matches.push(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'Paseo agent ID is ambiguous' : 'Paseo agent not found on this host')
  const agent = JSON.parse(await readFile(matches[0]!, 'utf8')) as { id?: string; provider?: string; persistence?: { provider?: string; sessionId?: string } }
  const sessionId = agent.persistence?.sessionId
  if (agent.id !== agentId || agent.provider !== 'codex' || agent.persistence?.provider !== 'codex' || !sessionId || !UUID.test(sessionId)) {
    throw new Error('Selected Paseo agent has no local Codex session')
  }
  const files: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) await walk(join(dir, entry.name), depth + 1)
      else if (entry.isFile() && (entry.name.endsWith(`-${sessionId}.jsonl`) || entry.name.endsWith(`_${sessionId}.jsonl`))) files.push(join(dir, entry.name))
    }
  }
  await walk(join(codexHome, 'sessions'), 0)
  if (files.length !== 1) throw new Error(files.length ? 'Codex session has multiple rollout files' : 'Codex rollout not found on this host')
  return { sessionId, file: files[0]! }
}

/** Read at most one bounded chunk without advancing past a partial JSONL record. */
async function chunk(file: string, offset: number, size: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(READ_LIMIT, Math.max(0, size - offset)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}

/** Start at the current end of the selected file, retaining only a bounded window as context, never replaying old messages. */
async function initialCursor(sessionId: string, file: string): Promise<Cursor> {
  const info = await stat(file), start = Math.max(0, info.size - READ_LIMIT), data = await chunk(file, start, info.size)
  const lines = data.toString('utf8').split('\n')
  if (start) lines.shift()
  const discard = info.size > 0 && data.at(-1) !== 10
  lines.pop()
  let context: ChatMessage[] = []
  for (const line of lines) { const message = conversationMessage(line); if (message) context = remember(context, message) }
  return { sessionId, file, dev: info.dev, ino: info.ino, offset: info.size, discard, context }
}

export const paseoChannel = (agentId: string): ChannelRef => ({ source: SOURCE, thread: `${SOURCE}:${agentId}`, address: { agentId } })

export function paseoTrigger(agentId: string, message: ChatMessage, context: ChatMessage[]): Trigger {
  return { id: key(SOURCE, agentId, message.id), source: SOURCE, threads: [{ source: SOURCE, id: `${agentId}:${message.id}` }],
    actor: { source: SOURCE, id: OPERATOR }, human: true, at: message.at, text: message.text,
    channel: paseoChannel(agentId), meta: { agentId, messageId: message.id, context } }
}

/** Only numbered answers join an existing ticket; ordinary conversation still follows the configured policy. */
export async function receivePaseo(ctx: SourceContext, agentId: string, message: ChatMessage, context: ChatMessage[]): Promise<void> {
  const trigger = paseoTrigger(agentId, message, context)
  const reply = /^(?:回复工单|回答工单|reply\s+ticket)\s*[:：#]?\s*([a-f0-9]{8,32})\s*[:：]\s*(\S[\s\S]*)$/i.exec(message.text)
  if (!reply && !/^(?:回复工单|回答工单|reply\s+ticket)/i.test(message.text)) {
    await ctx.receive(trigger)
    return
  }
  const matches = reply ? ctx.tickets.open().filter(ticket => ticket.id.startsWith(reply[1]!.toLowerCase())
    && ticket.attention && ctx.triggers.get(ticket.origin.triggerId)?.meta.agentId === agentId
    && ctx.triggers.get(ticket.origin.triggerId)?.source === SOURCE) : []
  const ticket = matches.length === 1 ? matches[0] : undefined
  const origin = ticket && ctx.triggers.get(ticket.origin.triggerId)
  const thread = origin?.threads.find(ref => ref.source === SOURCE)
  const subscriptions = thread && ctx.threads.get(`${SOURCE}:${thread.id}`)?.subscriptions
  if (!ticket || !thread || !subscriptions?.includes(ticket.id) || subscriptions.some(id => id !== ticket.id)) {
    ctx.notify({ id: key('paseo-answer-refused', trigger.id), channel: paseoChannel(agentId), kind: 'reply',
      text: '没有找到本会话中唯一匹配的待答工单，答案未转交，也没有创建新工单。请核对问题通知中的工单号，并使用：回复工单 <工单号前8位>：<你的答案>。' })
    return
  }
  trigger.threads = [thread]
  trigger.meta.answerToTicket = ticket.id
  // Include the exact question for workers whose chat never displayed it.
  trigger.meta.answerToQuestion = ticket.attention!.question
  await ctx.receive(trigger)
}

/** Restore pre-upgrade reply channels and queue each outstanding question once through the durable outbox. */
export function notifyPaseoQuestions(ctx: SourceContext): void {
  const selected = new Set(ctx.config<PaseoConfig>(SOURCE)?.sessions.map(session => session.id) ?? [])
  for (const ticket of ctx.tickets.open()) {
    const origin = ctx.triggers.get(ticket.origin.triggerId)
    const agentId = origin?.source === SOURCE && typeof origin.meta.agentId === 'string' ? origin.meta.agentId : undefined
    if (!agentId || !selected.has(agentId)) continue
    const channel = paseoChannel(agentId)
    ctx.tickets.bindChannel(ticket.id, channel)
    if (ticket.attention) ctx.notify({ id: key('attention-reply', ticket.attention.id), channel, kind: 'reply', ticketId: ticket.id,
      text: `工单「${ticket.title}」需要你回答：\n\n${ticket.attention.question}` })
  }
}

/** Consume only complete lines, committing each offset after receive; a replay is harmless because Trigger IDs are stable. */
export async function pollSession(ctx: SourceContext, agentId: string, resolved: { sessionId: string; file: string }): Promise<void> {
  const stored = ctx.state.get(cursorKey(agentId))
  if (!stored || stored.sessionId !== resolved.sessionId || stored.file !== resolved.file) {
    ctx.state.set(cursorKey(agentId), await initialCursor(resolved.sessionId, resolved.file))
    return
  }
  let cursor: Cursor = stored
  const info = await stat(cursor.file)
  if (info.dev !== cursor.dev || info.ino !== cursor.ino || info.size < cursor.offset) throw new Error('Codex rollout changed or was truncated; reselect the session')
  const data = await chunk(cursor.file, cursor.offset, info.size)
  let position = 0
  while (position < data.length) {
    if (!ctx.config<PaseoConfig>(SOURCE)?.sessions.some(item => item.id === agentId)) return
    const newline = data.indexOf(10, position)
    if (newline < 0) {
      // Tool output can exceed the chunk limit. Discard the entire oversized record, not its trailing fragment.
      if (data.length === READ_LIMIT && position === 0) ctx.state.set(cursorKey(agentId), { ...cursor, offset: cursor.offset + data.length, discard: true })
      break
    }
    const line = data.subarray(position, newline).toString('utf8')
    const next: Cursor = { ...cursor, offset: cursor.offset + newline - position + 1 }
    position = newline + 1
    if (cursor.discard) next.discard = false
    else {
      const message = conversationMessage(line)
      if (message) {
        if (!message.bot) {
          await receivePaseo(ctx, agentId, message, cursor.context)
        }
        next.context = remember(cursor.context, message)
      }
    }
    ctx.state.set(cursorKey(agentId), next)
    cursor = next
  }
}

export const paseoKind: SourceKind<PaseoConfig> = {
  kind: SOURCE, title: { zh: 'Paseo', en: 'Paseo' },
  description: { zh: '监听本机指定的 Paseo Codex 会话；问题和结果回到原会话，带工单号的回答继续原工单。', en: 'Observes selected local Paseo Codex sessions, returns questions and results, and routes numbered answers to their ticket.' },
  schema: ConfigSchema,
  fields: [{ key: 'sessions', type: 'rows', label: { zh: '接收的会话', en: 'Sessions' }, columns: [
    { key: 'id', type: 'text', label: { zh: 'Paseo agent ID', en: 'Paseo agent ID' } },
    { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
  ] }],
  health: [SOURCE],
  channel: { allowed: (address, config) => config.sessions.some(session => session.id === address.agentId),
    send: (host, message) => host.commands.paseoSend ? host.commands.paseoSend(message) : sendPaseo(message), link: () => ({ url: '', label: { zh: 'Paseo 会话', en: 'Paseo conversation' } }) },
  scope: ({ meta }, config) => config.sessions.some(item => item.id === meta.agentId)
    ? { listened: true, observed: true, row: String(meta.agentId) } : { listened: false, reason: 'session_not_allowed' },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    read: async (_commands, trigger, part) => part !== 'thread' ? { messages: [], body: {}, status: 'not_available' }
      : { messages: [...Array.isArray(trigger.meta.context) ? trigger.meta.context as ChatMessage[] : [],
        { id: String(trigger.meta.messageId), from: OPERATOR, at: trigger.at, text: trigger.text }], body: {} },
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的本机用户', en: 'Local users who may originate work' },
      hint: { zh: '填写 operator，代表所选会话中的本机用户。', en: 'Add operator for the local user in selected sessions.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } }, { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true }] }],
    explicit: { zh: '此来源观察普通对话，不将消息视为对调度器的直接点名。', en: 'This source observes conversation without marking messages as directly addressed to the orchestrator.' },
    rows: config => ConfigSchema.parse(config).sessions.map(session => ({ id: session.id, label: session.name || session.id,
      note: { zh: '观察新消息', en: 'Observe new messages' }, cells: { listedUnaddressed: true, unlistedAddressed: false, unlistedUnaddressed: true } })),
  },
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  const active = new Set<string>(), resolved = new Map<string, { value: { sessionId: string; file: string }; at: number }>()
  while (!signal.aborted) {
    const config = ctx.config<PaseoConfig>(SOURCE), sessions = config?.sessions ?? []
    for (const stored of ctx.state.keys(cursorKey)) {
      const id = stored.slice(cursorKey.prefix.length)
      if (!sessions.some(session => session.id === id)) ctx.state.set(cursorKey(id), undefined)
    }
    for (const id of active) if (!sessions.some(session => session.id === id)) {
      ctx.state.set(cursorKey(id), undefined); active.delete(id); resolved.delete(id)
    }
    if (!ctx.configured()) ctx.report(SOURCE, { state: 'paused', detail: 'Waiting for the deployment check' })
    else if (!sessions.length) ctx.report(SOURCE, { state: 'paused', detail: config ? 'No Paseo sessions configured' : 'Paseo Source is off' })
    else {
      const failures: string[] = []
      try { notifyPaseoQuestions(ctx) }
      catch { failures.push('Could not restore Paseo ticket questions') }
      for (const session of sessions) {
        if (signal.aborted) break
        active.add(session.id)
        try {
          // Re-read selected metadata so an agent resumed with another native session cannot silently read the old one.
          const cached = resolved.get(session.id)
          const found = cached && Date.now() - cached.at < 30_000 ? cached.value : await resolveSession(session.id)
          if (!cached || found !== cached.value) resolved.set(session.id, { value: found, at: Date.now() })
          await pollSession(ctx, session.id, found)
        } catch (error) {
          const known = ['Paseo agent ID is ambiguous', 'Paseo agent not found on this host', 'Selected Paseo agent has no local Codex session',
            'Codex session has multiple rollout files', 'Codex rollout not found on this host',
            'Codex rollout changed or was truncated; reselect the session']
          const message = error instanceof Error && known.includes(error.message) ? error.message : 'Session unavailable or unreadable'
          failures.push(`${session.id}: ${message}`); resolved.delete(session.id)
        }
      }
      ctx.report(SOURCE, failures.length ? { state: 'error', detail: failures.join('; ') }
        : { state: 'ready', detail: `Observing ${sessions.length} Paseo session(s)`, at: new Date().toISOString() })
    }
    await delay(2000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-paseo'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(paseoKind), 'paseo: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, paseoKind), controller = new AbortController()
    const running = watch(source, controller.signal).catch(() => { source.report(SOURCE, { state: 'error', detail: 'Paseo Source stopped' }) })
    return async () => { controller.abort(); await running }
  })
}
