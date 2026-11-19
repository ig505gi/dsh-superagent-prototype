import { afterEach, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { conversationMessage } from '../src/sources/paseo.ts'
import { isPaseoNotification, paseoNotification, sendPaseo } from '../src/sources/paseo-channel.ts'

const transport = vi.hoisted(() => ({ connect: vi.fn(), sendAgentMessage: vi.fn(), close: vi.fn() }))
vi.mock('@getpaseo/client/node', () => ({ createHostClient: vi.fn(() => transport) }))
const { createHostClient } = await import('@getpaseo/client/node')
const agentId = '6dbb8c45-832d-46f9-8a7d-d765990380c1'
const notice: OutboundMessage = { id: 'question-1', kind: 'reply', ticketId: '42bb40243d3e46714517a0e305957f45',
  channel: { source: 'paseo', thread: `paseo:${agentId}`, address: { agentId } }, text: '请选择类型来源：A 或 B？' }

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

it('sends the exact question and answer format with a stable ID and without replacing an active turn', async () => {
  transport.connect.mockResolvedValue(undefined); transport.sendAgentMessage.mockResolvedValue({}); transport.close.mockResolvedValue(undefined)
  expect(await sendPaseo(notice)).toBe('sent')
  expect(await sendPaseo(notice)).toBe('sent')
  const args = transport.sendAgentMessage.mock.calls
  expect(args[0]).toEqual([agentId, expect.stringContaining(notice.text), {
    messageId: 'dsh-superagent:question-1', activeTurnBehavior: 'steer',
  }])
  expect(args[1]).toEqual(args[0])
  expect(args[0]![1]).toContain('回复工单 42bb4024：<你的答案>')
  expect(transport.close).toHaveBeenCalledTimes(2)
})

it('excludes system notifications from intake even when Paseo records them as user.text', () => {
  const text = paseoNotification(notice)
  expect(isPaseoNotification(text)).toBe(true)
  expect(conversationMessage(JSON.stringify({ type: 'response_item', timestamp: '2026-11-16T01:00:00Z', payload: {
    type: 'message', id: 'injected-notice', role: 'user',
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] }, content: [{ type: 'input_text', text }],
  } }))).toBeUndefined()
})

it('fails delivery without leaking a credential-bearing transport error, so the outbox can retry', async () => {
  transport.connect.mockResolvedValue(undefined); transport.close.mockResolvedValue(undefined)
  transport.sendAgentMessage.mockRejectedValueOnce(new Error('ws://host?password=private-test-value'))
  await expect(sendPaseo(notice)).rejects.toThrow('Paseo notification delivery failed')
  expect(transport.close).toHaveBeenCalled()
  transport.sendAgentMessage.mockResolvedValueOnce({})
  expect(await sendPaseo(notice)).toBe('sent')
  expect(transport.sendAgentMessage.mock.calls[0]![2]).toEqual(transport.sendAgentMessage.mock.calls[1]![2])
})

it('rejects invalid destinations and uses environment-based authentication', async () => {
  await expect(sendPaseo({ ...notice, channel: { ...notice.channel, address: { agentId: '../bad' } } })).rejects.toThrow('Invalid Paseo')
  expect(createHostClient).not.toHaveBeenCalled()
  vi.stubEnv('PASEO_PASSWORD', 'test-only-password')
  transport.connect.mockResolvedValue(undefined); transport.sendAgentMessage.mockResolvedValue({}); transport.close.mockResolvedValue(undefined)
  await sendPaseo(notice)
  expect(createHostClient).toHaveBeenCalledWith('127.0.0.1:6767', expect.objectContaining({ password: 'test-only-password' }))
  expect(paseoNotification(notice)).not.toContain('test-only-password')
})
