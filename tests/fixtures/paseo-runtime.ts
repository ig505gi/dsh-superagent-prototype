/** An injected daemon transport with real application sessions, private HTTP guards, and persistent SQLite ledgers. */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { PaseoRuntime, type PaseoOptions } from '../../src/runtime/paseo.ts'
import { Runtime } from '../../src/app/runtime.ts'
import { Setup } from '../../src/app/setup.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema, type RoleModel } from '../../src/policy.ts'
import { feishuKind } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import { loadConfig } from '../../src/server/config.ts'
import { testDeployment, testMachine } from './deployment.ts'
import { feishu, MEMBER, CHAT } from './host.ts'
import type { Binding } from '../../src/runtime/state.ts'

type Client = NonNullable<PaseoOptions['client']>
type Snapshot = Awaited<ReturnType<Client['createAgent']>>
export const assessorProfile: RoleModel = { profileId: 'eval-example', name: 'Assessor', provider: 'pi', model: 'example-pi', thinkingOptionId: 'high' }
export const executorProfile: RoleModel = { profileId: 'worker-example', name: 'Executor', provider: 'codex', model: 'example-codex',
  modeId: 'full-access', thinkingOptionId: 'medium', featureValues: { reasoning: true } }
/** Controlled daemon simulator. It never calls a model; production loopback endpoints still authenticate every request. */
export class TestDaemon {
  readonly snapshots: Map<string, Snapshot> = new Map()
  readonly history = new Map<string, { seqStart: number; seqEnd: number; item: Record<string, unknown> }[]>()
  readonly creates: Parameters<Client['createAgent']>[0][] = []
  readonly sent: { agentId: string; text: string; messageId: string }[] = []
  readonly archived: string[] = []
  profiles = [assessorProfile, executorProfile]
  providers = [{ provider: 'pi', available: true }, { provider: 'codex', available: true }]
  exposeInput = true
  timelineEpoch = 'epoch'
  private epoch = 0
  private readonly raw = new Set<(message: unknown) => void>()
  private readonly listeners = new Set<(event: unknown) => void>()
  private timestamp() { return new Date(1_800_000_000_000 + this.epoch++).toISOString() }
  readonly client = {
    isConnected: true,
    connect: async () => { for (const cb of this.raw) cb({ type: 'status', payload: { status: 'server_info', serverId: 'srv_test' } }) },
    close: async () => {},
    subscribeRawMessages: (cb: (value: unknown) => void) => { this.raw.add(cb); return () => { this.raw.delete(cb) } },
    subscribe: (cb: (value: unknown) => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb) } },
    createAgent: async (input: Parameters<Client['createAgent']>[0]) => {
      this.creates.push(input)
      if (this.snapshots.has(input.agentId!)) return this.snapshots.get(input.agentId!)!
      const snapshot = { id: input.agentId, provider: input.provider, model: input.model ?? null, thinkingOptionId: input.thinkingOptionId,
        currentModeId: input.modeId ?? null, title: input.title, cwd: input.cwd,
        workspaceId: `workspace-${input.agentId}`, persistence: { sessionId: `native-${input.agentId}` }, status: 'idle', updatedAt: this.timestamp() } as Snapshot
      this.snapshots.set(snapshot.id, snapshot); this.history.set(snapshot.id, []); return snapshot
    },
    fetchAgent: async (id: string) => this.snapshots.has(id) ? { agent: this.snapshots.get(id) } : null,
    fetchAgentTimeline: async (id: string, options: { limit?: number; cursor?: { seq: number } } = {}) => {
      const entries = this.history.get(id) ?? [], before = options.cursor?.seq ?? Infinity, filtered = entries.filter(row => row.seqStart < before)
      const page = filtered.slice(-(options.limit ?? 500))
      return { agentId: id, agent: this.snapshots.get(id), entries: page, epoch: this.timelineEpoch, hasOlder: filtered.length > page.length,
        startCursor: page[0] ? { epoch: this.timelineEpoch, seq: page[0].seqStart } : undefined }
    },
    sendAgentMessage: async (id: string, text: string, options: { messageId: string }) => {
      const history = this.history.get(id)!
      if (!this.sent.some(row => row.agentId === id && row.messageId === options.messageId)) {
        this.sent.push({ agentId: id, text, messageId: options.messageId })
        if (this.exposeInput) history.push({ seqStart: history.length + 1, seqEnd: history.length + 1, item: { type: 'user_message', clientMessageId: options.messageId, text } })
      }
      this.status(id, 'running', false); return { accepted: true }
    },
    cancelAgent: async (id: string) => { this.status(id, 'idle') },
    archiveAgent: async (id: string) => {
      this.archived.push(id)
      this.snapshots.set(id, { ...this.snapshots.get(id)!, archivedAt: this.timestamp() })
      this.status(id, 'closed')
    },
    updateAgent: async (id: string, { name }: { name: string }) => { this.snapshots.set(id, { ...this.snapshots.get(id)!, title: name }) },
    getDaemonConfig: async () => ({ config: { agentProfiles: this.profiles.map(({ profileId, ...profile }) => ({ ...profile, id: profileId })) } }),
    listAvailableProviders: async () => ({ providers: this.providers }),
  } as unknown as Client
  status(id: string, status: string, publish = true): void {
    const snapshot = { ...this.snapshots.get(id)!, status, updatedAt: this.timestamp() } as Snapshot
    this.snapshots.set(id, snapshot)
    if (publish) for (const cb of this.listeners) cb({ type: 'agent_update', payload: { kind: 'upsert', agent: snapshot } })
  }
  append(id: string, item: Record<string, unknown>): void {
    const history = this.history.get(id)!
    const seq = (history.at(-1)?.seqEnd ?? 0) + 1
    history.push({ seqStart: seq, seqEnd: seq, item })
  }
  showInput(index: number): void {
    const { agentId, messageId, text } = this.sent[index]!
    this.append(agentId, { type: 'user_message', clientMessageId: messageId, text })
  }
}

export async function managedFixture({ instanceId, ...options }: PaseoOptions & { instanceId?: string } = {}, directory?: string, daemon = new TestDaemon()) {
  const root = directory ?? mkdtempSync(join(tmpdir(), 'superagent-runtime-'))
  vi.spyOn(Setup.prototype, 'run').mockResolvedValue(true)
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(true)
  vi.spyOn(Setup.prototype, 'deployment', 'get').mockImplementation(() => testDeployment({ stateDir: root }))
  if (!directory) {
    const seed = new Store(join(root, 'orchestrator.sqlite'))
    seed.saveSettings(SettingsSchema.parse({ ...seed.settings(), eval: { mode: 'auto', model: assessorProfile }, executor: { model: executorProfile },
      policy: { sources: { feishu: { allowed: [{ id: MEMBER }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } } })); seed.close()
  }
  const adapter = new PaseoRuntime(loadConfig({ stateDir: root, instanceId }), { client: daemon.client, ...options })
  await adapter.ready
  const runtime = new Runtime(adapter.context, testMachine({ stateDir: root }), () => {})
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  await runtime.ready
  const rpc = async (owner: string, path: string, body: unknown, method = 'POST') => {
    const binding = adapter.binding(owner), controls = JSON.parse(readFileSync(binding.file, 'utf8'))
    return fetch(`${controls.endpoint}/${path}`, { method, headers: { authorization: `Bearer ${controls.capability}` },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  }
  const sync = (owner: string) => adapter.context.sessionController.inspect(owner)
  const acceptedTicket = async () => {
    const trigger = feishu(`t${Date.now()}`, 'Please fix a regression')
    runtime.receive(trigger); await runtime.idle()
    const result = await rpc(runtime.masterId, 'tool', { name: 'orchestrator_route', args: { decisions: [{ kind: 'accept', trigger_id: trigger.id,
      title: 'Fix regression', worktree_name: 'regression', acknowledgement: 'Received' }] } })
    const answer = JSON.stringify(await result.json()); if (answer.includes('isError')) throw new Error(answer)
    await runtime.idle()
    const ticket = runtime.store.tickets.list().find(ticket => ticket.origin.triggerId === trigger.id)!
    return { ticket, trigger, owner: `worker-${ticket.id}` }
  }
  const close = async () => { await runtime.stop(); await adapter.close() }
  return { root, adapter, runtime, daemon, rpc, sync, acceptedTicket, close }
}
export type ManagedFixture = Awaited<ReturnType<typeof managedFixture>>
export type { Binding }
