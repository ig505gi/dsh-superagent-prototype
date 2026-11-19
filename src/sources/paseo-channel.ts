/** Deliver ticket notices to the existing local Paseo agent with a durable message ID. */
import { createHostClient } from '@getpaseo/client/node'
import type { OutboundMessage } from '../core/index.ts'

export const PASEO_AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOTICE = '[dsh-superagent-notification:'

/** Notifications sent through Paseo appear as user messages; never ingest them as human authorization. */
export const isPaseoNotification = (text: string): boolean => text.startsWith(NOTICE)

export function paseoNotification(message: OutboundMessage): string {
  const reply = message.ticketId ? `\n\n工单号：${message.ticketId}\n若这条通知要求回答，请直接在本会话发送：\n回复工单 ${message.ticketId.slice(0, 8)}：<你的答案>` : ''
  return `${NOTICE}${message.id}]\n这是 Superagent 的系统通知，不是用户的新需求或用户的回答。`
    + '请只把下方通知内容原样展示给用户，然后结束回复。不要调用工具、代答、执行任务或转派其他 agent。'
    + '用户按工单号回复后，Superagent 会自动送回原工单；你不需要再次执行或转派。\n\n通知内容：\n'
    + message.text + reply
}

export async function sendPaseo(message: OutboundMessage): Promise<'sent'> {
  const agentId = message.channel.address.agentId
  if (!agentId || !PASEO_AGENT_ID.test(agentId)) throw new Error('Invalid Paseo notification destination')
  let client: ReturnType<typeof createHostClient> | undefined
  try {
    client = createHostClient(process.env.DSH_SUPERAGENT_PASEO_URL || '127.0.0.1:6767', {
      clientId: 'dsh-superagent', clientType: 'cli', appVersion: '0.15.0',
      password: process.env.PASEO_PASSWORD, connectTimeoutMs: 15_000,
      reconnect: { enabled: false }, suppressSendErrors: true,
    })
    await client.connect()
    await client.sendAgentMessage(agentId, paseoNotification(message), {
      messageId: `dsh-superagent:${message.id}`, activeTurnBehavior: 'steer',
    })
    return 'sent'
  } catch {
    // Connection errors can contain credential-bearing URLs. Keep them out of receipts and panel logs.
    throw new Error('Paseo notification delivery failed; check the local daemon and its authentication')
  } finally { await client?.close().catch(() => {}) }
}
