/** DingTalk application bot: Stream intake and outbound group messages. */
import type { Context } from '../runtime/context.ts'
import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type OutboundMessage, type ThreadRef, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const SOURCE = 'dingtalk'
const ConfigSchema = z.object({ groups: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict())
  .refine(groups => new Set(groups.map(group => group.id)).size === groups.length, 'Duplicate group IDs').default([]) }).strict()
export type DingtalkConfig = z.infer<typeof ConfigSchema>
const MessageSchema = z.looseObject({ msgId: z.string().min(1), conversationId: z.string().min(1), conversationType: z.literal('2'),
  senderStaffId: z.string().min(1), senderNick: z.string().optional(), robotCode: z.string().min(1), createAt: z.number().finite(),
  msgtype: z.literal('text'), text: z.looseObject({ content: z.string().trim().min(1) }), isInAtList: z.boolean().optional(),
  chatbotUserId: z.string().optional(), atUsers: z.array(z.looseObject({ dingtalkId: z.string() })).optional() })
type Message = z.infer<typeof MessageSchema>

/** A new group message starts a distinct thread unless it names a pending question in that group. */
export function dingtalkTrigger(message: Message, thread?: ThreadRef): Trigger {
  const id = key(SOURCE, message.conversationId, message.msgId)
  const ref = thread ?? { source: SOURCE, id: `${message.conversationId}:${message.msgId}` }
  return { id, source: SOURCE, threads: [ref], actor: { source: SOURCE, id: message.senderStaffId }, human: true, addressed: 'mention',
    at: new Date(message.createAt).toISOString(), text: message.text.content,
    channel: { source: SOURCE, thread: `${SOURCE}:${message.conversationId}`, address: { conversationId: message.conversationId, robotCode: message.robotCode } },
    meta: { chatId: message.conversationId, messageId: message.msgId, ...(message.senderNick ? { senderName: message.senderNick } : {}) } }
}

export function pendingThread(ctx: SourceContext, message: Message): ThreadRef | undefined {
  const pending = ctx.tickets.open().filter(ticket => ticket.attention && ticket.mandate.actor.source === SOURCE
    && ticket.channels.some(channel => channel.source === SOURCE && channel.address.conversationId === message.conversationId))
  const reference = /(?:工单|ticket)\s*[:：#]?\s*([a-f0-9]{8,32})\b/i.exec(message.text.content)?.[1]?.toLowerCase()
  const matched = reference ? pending.filter(ticket => ticket.id.toLowerCase().startsWith(reference)) : []
  if (matched.length !== 1) return undefined
  const origin = ctx.triggers.get(matched[0]!.origin.triggerId)
  return origin?.threads.find(thread => thread.source === SOURCE)
}

export async function receiveDingtalk(ctx: SourceContext, input: unknown): Promise<void> {
  const parsed = MessageSchema.safeParse(input)
  if (!parsed.success) return
  const mentioned = parsed.data.isInAtList === true || (!!parsed.data.chatbotUserId
    && parsed.data.atUsers?.some(user => user.dingtalkId === parsed.data.chatbotUserId))
  if (!mentioned) return
  const config = ctx.config<DingtalkConfig>(SOURCE)
  if (!config?.groups.some(group => group.id === parsed.data.conversationId)) return
  const trigger = dingtalkTrigger(parsed.data, pendingThread(ctx, parsed.data))
  await ctx.receive(trigger)
}

async function readCredential(name: 'DINGTALK_CLIENT_ID' | 'DINGTALK_CLIENT_SECRET'): Promise<string | undefined> {
  const fileName = `${name}_FILE`
  const inline = process.env[name], file = process.env[fileName]
  if (file === undefined) return inline?.trim()
  if (inline !== undefined) throw new Error(`Set only one of ${name} and ${fileName}`)
  if (!isAbsolute(file)) throw new Error(`${fileName} must be an absolute path`)
  let value: string
  try { value = (await readFile(file, 'utf8')).replace(/\r?\n$/, '') }
  catch { throw new Error(`Cannot read ${fileName}`) }
  if (!value.trim()) throw new Error(`${fileName} is empty`)
  return value
}

async function credentials(): Promise<{ clientId: string; clientSecret: string } | undefined> {
  const [clientId, clientSecret] = await Promise.all([readCredential('DINGTALK_CLIENT_ID'), readCredential('DINGTALK_CLIENT_SECRET')])
  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

/** Send via the application bot API so a long-running ticket does not depend on a temporary session webhook. */
export async function sendDingtalk(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const account = await credentials(), { conversationId, robotCode } = message.channel.address
  if (!account || !conversationId || !robotCode) throw new Error('DingTalk bot credentials or group address are unavailable')
  const request = async (url: string, body: unknown, accessToken?: string): Promise<unknown> => {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', ...(accessToken ? { 'x-acs-dingtalk-access-token': accessToken } : {}) }, body: JSON.stringify(body) })
      .catch(() => { throw new Error('DingTalk request failed') })
    if (!response.ok) throw new Error(`DingTalk request failed with HTTP ${response.status}`)
    try { return await response.json() } catch { throw new Error('DingTalk returned invalid JSON') }
  }
  const token = z.looseObject({ accessToken: z.string().min(1) }).parse(await request('https://api.dingtalk.com/v1.0/oauth2/accessToken',
    { appKey: account.clientId, appSecret: account.clientSecret })).accessToken
  const text = message.ticketId ? `${message.text}\n\n回复问题请 @ 机器人并带上：工单 ${message.ticketId.slice(0, 8)}` : message.text
  z.looseObject({ processQueryKey: z.string().min(1) }).parse(await request('https://api.dingtalk.com/v1.0/robot/groupMessages/send',
    { robotCode, openConversationId: conversationId, msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: '任务通知', text }) }, token))
  return 'sent'
}

export const dingtalkKind: SourceKind<DingtalkConfig> = {
  kind: SOURCE, title: { zh: '钉钉', en: 'DingTalk' },
  description: { zh: '接收指定群里 @ 机器人的文本消息。', en: 'Receives text messages mentioning the bot in configured groups.' },
  schema: ConfigSchema,
  fields: [{ key: 'groups', type: 'rows', label: { zh: '接收的群', en: 'Groups' }, columns: [
    { key: 'id', type: 'text', label: { zh: '群会话 ID', en: 'Conversation ID' } },
    { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
  ] }],
  health: ['dingtalk'],
  scope: ({ meta }, config) => config.groups.some(group => group.id === meta.chatId)
    ? { listened: true, observed: false, row: String(meta.chatId) } : { listened: false, reason: 'chat_not_allowed' },
  channel: { allowed: (address, config) => config.groups.some(group => group.id === address.conversationId), send: sendDingtalk,
    link: () => ({ url: '', label: { zh: '钉钉群', en: 'DingTalk group' } }) },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的钉钉用户', en: 'DingTalk users who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '员工 ID', en: 'Staff ID' } }, { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
    ] }],
    explicit: { zh: '名单内的人在指定群 @ 机器人。', en: 'A listed person mentions the bot in a configured group.' },
  },
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let account: Awaited<ReturnType<typeof credentials>>
  try { account = await credentials() }
  catch (error) {
    if (!signal.aborted) ctx.report(SOURCE, { state: 'error', detail: (error as Error).message })
    return
  }
  let client: DWClient | undefined
  let processing = Promise.resolve()
  try {
    while (!signal.aborted) {
      const config = ctx.config<DingtalkConfig>(SOURCE)
      if (!config || !config.groups.length || !account) {
        client?.disconnect(); client = undefined
        ctx.report(SOURCE, { state: 'paused', detail: !config ? 'DingTalk Source is off' : !account ? 'DingTalk bot credentials are not set' : 'No DingTalk groups configured' })
      } else if (!client?.connected) {
        client?.disconnect()
        const current = client = new DWClient({ ...account, keepAlive: true, debug: false })
        current.config.autoReconnect = false
        current.config.subscriptions = []
        current.registerCallbackListener(TOPIC_ROBOT, (event: DWClientDownStream) => {
          processing = processing.then(async () => {
            let input: unknown
            try { input = JSON.parse(event.data) } catch { return }
            await receiveDingtalk(ctx, input)
            if (current.connected) {
              current.socketCallBackResponse(event.headers.messageId, null)
              ctx.report(SOURCE, { state: 'ready', detail: 'DingTalk Stream connected', at: new Date().toISOString() })
            }
          }).catch(() => { if (!signal.aborted) ctx.report(SOURCE, { state: 'error', detail: 'Could not process a DingTalk message' }) })
        })
        let abandoned = false
        const connection = current.connect().finally(() => { if (abandoned || signal.aborted) current.disconnect() })
        await Promise.race([connection, delay(15_000, undefined, { signal }).catch(() => {})])
        if (!current.connected) { abandoned = true; current.disconnect() }
        if (!signal.aborted) ctx.report(SOURCE, current.connected
          ? { state: 'ready', detail: 'DingTalk Stream connected', at: new Date().toISOString() }
          : { state: 'error', detail: 'DingTalk Stream connection failed; retrying' })
      }
      await delay(5000, undefined, { signal }).catch(() => {})
    }
  } finally { client?.disconnect(); await processing }
}

export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, dingtalkKind), controller = new AbortController()
    const running = watch(source, controller.signal).catch(() => { source.report(SOURCE, { state: 'error', detail: 'DingTalk Stream stopped' }) })
    return async () => { controller.abort(); await running }
  })
}
