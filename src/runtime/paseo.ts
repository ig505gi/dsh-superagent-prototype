/** Paseo conversations, durable input receipts, and the private application tool gateway. */
import { createHostClient } from '@getpaseo/client/node'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { latestAssignment, liveTicket, key } from '../core/index.ts'
import type { Runtime } from '../app/runtime.ts'
import type { StandaloneConfig } from '../server/config.ts'
import { resolveRoleModel } from '../app/role-models.ts'
import { mandateInstructions } from '../executor/paseo.ts'
import { workerBin } from '../infra/environment.ts'
import { policyVersion, RoleModelSchema, settingsPolicy, type RoleModel } from '../policy.ts'
import { paseoNotification, PASEO_AGENT_ID } from '../sources/paseo-channel.ts'
import type { OutboundMessage } from '../core/index.ts'
import type { Health } from '../sources/host.ts'
import { Context } from './context.ts'
import { commandEnvironment, LocalProcesses } from './process.ts'
import { RuntimeState, type Binding, type Delivery, type Notice, type OwnedExecution } from './state.ts'
import { ManagedAgent } from './session.ts'
import { ShellJobs } from './jobs.ts'
import { safeProviderFailure } from './failures.ts'
import { deliveryBody, deliveryReference, digest, stableId } from './envelope.ts'
import { contextBlock, snapshotBody, sha256, type EffectiveSnapshot } from './snapshot.ts'
import { managedToolDefinitions, executeManagedTool, controlToolNames } from './tools.ts'
import type { Agent, ModelCatalog, ModelSelection, SessionController, SessionEvent, UserMessage } from './types.ts'

const at = (): string => new Date().toISOString()
const acceptsTurn = (status: string): boolean => status === 'idle' || status === 'error'
type DaemonClient = ReturnType<typeof createHostClient>
type AgentSnapshotPayload = Awaited<ReturnType<DaemonClient['createAgent']>>
const idleForReplacement = (snapshot: AgentSnapshotPayload): boolean =>
  !snapshot.activeTurn && (acceptsTurn(snapshot.status) || snapshot.status === 'closed')
type TimelinePage = Awaited<ReturnType<DaemonClient['fetchAgentTimeline']>>
type TimelineUser = Extract<TimelinePage['entries'][number]['item'], { type: 'user_message' }>
type TurnEvidence = 'input' | 'tool' | 'reply'
type DeliveryHistory = { held: Set<string>; ambiguous: Set<string>; turns: Map<string, TurnEvidence>; epoch?: string; snapshot?: AgentSnapshotPayload }
const legacyRecoveryPrompt = 'Continue the previously delivered application input that has not yet been consumed. Do not repeat completed work.'
const recoveryPrompt = 'Continue the previously delivered application input that was interrupted. Do not repeat completed work.'
const recoveryBody = (id: string, body: string): boolean =>
  body === legacyRecoveryPrompt || body === deliveryBody(id, legacyRecoveryPrompt) || body === deliveryBody(id, recoveryPrompt)
const messageBody = (message: UserMessage): string =>
  deliveryBody(message.id, message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
const directDelivery = (row: Delivery): boolean => row.message.source.kind === 'user' && row.id === `${row.owner}:direct:${row.remoteId}`
const nativeId = (item: TimelineUser): string | undefined => item.messageId === item.clientMessageId ? undefined : item.messageId
function changedIdentity(binding: Binding, snapshot: AgentSnapshotPayload): Binding['identityError'] {
  if (snapshot.provider !== binding.provider) return 'provider-changed'
  if (binding.nativeSessionId && snapshot.persistence?.sessionId && binding.nativeSessionId !== snapshot.persistence.sessionId) return 'native-session-changed'
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const nonempty = (value: string | undefined): string | undefined => value?.trim() ? value : undefined
const launchConfig = ({ profileId: _id, name: _name, ...config }: RoleModel): ModelSelection => config
const sessionEnvironment = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT',
  'GH_CONFIG_DIR', 'GH_HOST', 'GH_PROMPT_DISABLED', 'GLAB_CONFIG_DIR', 'GLAB_AGENT_REAL', 'GLAB_NO_PROMPT', 'GITLAB_HOST'])
interface Controls { endpoint: string; capability: string }
export interface PaseoOptions { client?: DaemonClient; password?: string; afterRemoteSend?: (delivery: Delivery) => void | Promise<void> }

/** Owns this application's visible Paseo agents and authorizes calls to its tools. */
export class PaseoRuntime {
  readonly context = new Context()
  readonly state: RuntimeState
  readonly client: DaemonClient
  readonly jobs: ShellJobs
  readonly ready: Promise<void>
  private readonly server: Server
  private endpoint = ''
  private serverId = ''
  private readonly capabilities = new Map<string, string>()
  private readonly creating = new Map<string, Promise<ManagedAgent>>()
  private readonly toolSignals = new Map<string, AbortController>()
  private readonly rotating = new Set<string>()
  private readonly updates = new Map<string, Promise<void>>()
  private readonly sending = new Map<string, Promise<void>>()
  private readonly submitting = new Map<string, number>()
  private readonly queueSends = new Map<string, Promise<void>>()
  private readonly flushing = new Set<string>()
  private readonly cancelling = new Map<string, Promise<void>>()
  private readonly childWaiters = new Map<string, Set<() => void>>()
  private readonly childrenClosing = new Set<string>()
  private readonly stoppingChildren = new Map<string, Promise<void>>()
  private readonly failingChildren = new Map<string, Promise<void>>()
  private mainProblem?: Pick<Health, 'detail' | 'at'>
  private readonly archiveFailures = new Set<string>()
  private callbacksReady = false
  private readonly subscriptions: (() => void)[] = []
  private closing = false
  private readonly poll: ReturnType<typeof setInterval>
  constructor(readonly config: StandaloneConfig, private readonly options: PaseoOptions = {}) {
    this.state = new RuntimeState(join(config.stateDir, 'paseo.sqlite'))
    this.client = options.client ?? createHostClient(config.paseo.endpoint, { clientId: this.value('client-id', () => randomUUID()), clientType: 'cli', appVersion: '0.15.0',
      password: options.password, connectTimeoutMs: 15_000, reconnect: { enabled: true }, suppressSendErrors: true })
    this.server = createServer((request, response) => { void this.control(request, response) })
    const ctx = this.context
    ctx.runtime = this
    ctx.reflect.provide('subprocess', new LocalProcesses())
    ctx.reflect.provide('workspaceRegistry', { create: async (cwd: string) => ({ id: cwd }) })
    const controller: SessionController = {
      resolveAgent: async id => {
        const binding = this.state.get('binding', id)
        return binding && !binding.closed ? { agent: await this.ensure(binding) } : { error: { code: 'session/not-found' } }
      },
      create: async ({ sessionId, workspaceId, agentPreset }) => { await this.create(sessionId, workspaceId, agentPreset) },
      rename: async ({ sessionId, title }) => {
        const binding = this.binding(sessionId)
        await this.client.updateAgent(binding.agentId, { name: this.sessionTitle(title) })
      },
      inspect: async id => { await this.syncTimeline(this.binding(id)); return { events: this.agent(id).session.snapshotEvents() } },
      modelCatalog: () => this.modelCatalog(),
    }
    ctx.reflect.provide('sessionController', controller)
    ctx.reflect.provide('sessionPersistence', { flush: async () => {}, open: async (id: string) => ({
      read: async (offset: number, limit: number) => ({ events: this.state.list('event', id).slice(offset, offset + limit) }), [Symbol.asyncDispose]: async () => {},
    }) })
    ctx.reflect.provide('llm', { resolveModelInfo: async (_provider: string, _model: string) => ({ inputModalities: ['text', 'image'] }) })
    ctx.reflect.provide('attachments', { imageLimits: { maxImageBytes: 10_000_000, maxMessageImageBytes: 20_000_000 },
      saveImage: async (input: { data: Uint8Array; mediaType: string; name: string }) => {
        const id = randomUUID(), directory = join(config.stateDir, 'attachments'); mkdirSync(directory, { recursive: true, mode: 0o700 })
        const path = join(directory, id); writeFileSync(path, input.data, { mode: 0o600 }); return { id, path, mediaType: input.mediaType, name: input.name }
      } })
    this.jobs = new ShellJobs(this.state, config.stateDir, job => this.jobEnded(job))
    ctx.reflect.provide('jobs', this.jobs)
    ctx.reflect.provide('subagents', {
      listChildren: async (parent: string) => this.state.list('binding').filter(child => child.parent === parent).map(child => ({ id: child.id })),
      waitForChildren: async (parent: Agent) => {
        const live = this.children(parent.id).filter(child => this.childBusy(child.id))
        await Promise.all(live.map(child => new Promise<void>(resolve => {
          let waiters = this.childWaiters.get(child.id); if (!waiters) this.childWaiters.set(child.id, waiters = new Set())
          waiters.add(resolve)
          if (!this.childBusy(child.id)) this.wakeChildWaiters(child.id)
        }))); return live.length > 0
      },
      drainChildren: async (_parent: Agent, ids: readonly string[]) => { await Promise.all(ids.map(id => this.stopChild(id))) },
      drainDescendants: async (parents: readonly Agent[]) => { await Promise.all(parents.flatMap(parent => this.children(parent.id).map(child => this.stopChild(child.id)))) },
      interrupt: (id: string) => { void this.stopChild(id) },
    })
    this.subscriptions.push(this.client.subscribeRawMessages(message => {
      if (message.type === 'status' && message.payload.status === 'server_info' && typeof message.payload.serverId === 'string') {
        this.serverId = message.payload.serverId; this.state.put('value', 'server-id', { id: 'server-id', value: this.serverId })
      }
    }))
    this.subscriptions.push(this.client.subscribe(event => {
      if (event.type !== 'agent_update' || event.payload.kind !== 'upsert') return
      const snapshot = event.payload.agent
      const binding = this.state.list('binding').find(item => item.agentId === snapshot.id)
      if (binding && !binding.closed) this.queueUpdate(binding.id, snapshot)
    }))
    this.ready = this.initialize()
    // Snapshot reconciliation complements live subscriptions and repairs gaps after reconnects.
    this.poll = setInterval(() => { if (!this.closing && this.client.isConnected) void this.reconcile().catch(() => {}) }, 3000); this.poll.unref()
  }
  get host(): Runtime { return this.context.orchestrator as Runtime }
  get mainSessionProblem(): Pick<Health, 'detail' | 'at'> | undefined { return this.mainProblem }
  private sessionTitle(title: string): string {
    if (!this.config.instanceId) return title
    const prefix = `[${this.config.instanceId}] `
    return title.startsWith(prefix) ? title : prefix + title
  }
  private value(id: string, initial: () => string): string {
    const existing = this.state.get('value', id); if (existing) return existing.value
    const value = initial(); this.state.put('value', id, { id, value }); return value
  }
  binding(id: string): Binding { const value = this.state.get('binding', id); if (!value) throw new Error('Unknown application session'); return value }
  agent(id: string): ManagedAgent { const agent = this.context.agents.get(id); if (!(agent instanceof ManagedAgent)) throw new Error('Application session is unavailable'); return agent }
  link(id: string): { serverId: string; agentId: string } | undefined {
    const binding = this.state.get('binding', id); return binding?.createdRemote && binding.serverId ? { serverId: binding.serverId, agentId: binding.agentId } : undefined
  }
  private async initialize(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve() }) })
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Application tool gateway failed to bind')
    this.endpoint = `http://127.0.0.1:${address.port}`
    // Paseo keeps the per-session executable path across daemon restarts.
    for (const binding of this.state.list('binding')) {
      if (binding.closed) continue
      if (!binding.provider) this.state.put('binding', binding.id, { ...binding, provider: binding.model.provider })
      this.controls(binding)
      if (binding.profile) this.writeToolWrapper(binding)
    }
    for (const replacement of this.state.list('replacement')) this.controls(replacement)
    await this.client.connect()
    if (!this.serverId) this.serverId = this.state.get('value', 'server-id')?.value ?? ''
  }
  private controls(binding: Binding, capability?: string): void {
    let control: Controls
    if (capability) control = { capability, endpoint: this.endpoint }
    else {
      control = JSON.parse(readFileSync(binding.file, 'utf8')) as Controls
      if (digest(control.capability) !== binding.capabilityHash) throw new Error('Managed session capability file is inconsistent')
      control = { capability: control.capability, endpoint: this.endpoint }
    }
    mkdirSync(dirname(binding.file), { recursive: true, mode: 0o700 })
    const temporary = `${binding.file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(control), { mode: 0o600 }); renameSync(temporary, binding.file)
    this.state.afterCommit(() => { this.capabilities.set(binding.capabilityHash, binding.id) })
  }
  private writeToolWrapper(binding: Binding): string {
    const directory = join(dirname(binding.file), 'bin')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const built = fileURLToPath(new URL('./tool-cli.js', import.meta.url))
    const entry = existsSync(built) ? built : fileURLToPath(new URL('./tool-cli.ts', import.meta.url))
    const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
    const wrapper = join(directory, 'superagent-tool'), temporary = wrapper + '.' + process.pid + '.tmp'
    writeFileSync(temporary, ['#!/bin/sh', 'exec ' + quote(process.execPath) + ' ' + quote(entry) + ' "$@"', ''].join('\n'), { mode: 0o700 })
    renameSync(temporary, wrapper)
    return directory
  }
  private async create(id: string, directory: string, preset: string, parent?: Binding, profile?: RoleModel): Promise<ManagedAgent> {
    await this.ready
    if (parent) this.assertBinding(parent)
    const existing = this.state.get('binding', id); if (existing) return this.ensure(existing)
    const role = parent ? 'worker' : preset === 'dsh-superagent-router' ? 'orchestrator' : 'worker'
    const ticketId = parent?.ticketId ?? (id.startsWith('worker-') ? id.slice(7) : undefined)
    const assignmentId = ticketId ? latestAssignment(this.host.store.tickets.get(ticketId)!)?.id : undefined
    const selection = profile ?? parent?.profile ?? this.roleProfile(role)
    const binding = this.reserveBinding({ id, cwd: role === 'orchestrator' ? this.config.paseo.main.cwd ?? directory : directory,
      role, ticketId, assignmentId, generation: parent?.generation ?? 1, parent: parent?.id }, selection)
    return this.ensure(binding)
  }
  private roleProfile(role: Binding['role']): RoleModel {
    const settings = this.host.store.settings()
    const profile = (role === 'orchestrator' ? settings.eval : settings.executor).model
    if (!profile) throw new Error('Select a Paseo Agent Profile for this role in Settings')
    return profile
  }
  private reserveBinding(base: Pick<Binding, 'id' | 'cwd' | 'role' | 'ticketId' | 'assignmentId' | 'generation' | 'parent'>,
    profile: RoleModel, kind: 'binding' | 'replacement' = 'binding'): Binding {
    const agentId = randomUUID(), capability = randomBytes(32).toString('hex')
    const file = join(this.config.stateDir, 'bindings', agentId, 'control.json')
    const binding: Binding = { ...base, agentId, serverId: this.serverId, profile, provider: profile.provider, model: launchConfig(profile),
      capabilityHash: digest(capability), file, createdRemote: false, status: 'idle' }
    this.controls(binding, capability)
    this.state.put(kind, base.id, binding)
    return binding
  }
  private ensure(binding: Binding): Promise<ManagedAgent> {
    const existing = this.creating.get(binding.id); if (existing) return existing
    const run = this.ensureRemote(binding).catch(error => {
      if (binding.role === 'orchestrator' && !this.mainProblem) {
        this.mainProblem = { detail: 'Paseo could not restore the main session. Check the original conversation in Paseo or select another Profile in Settings → Eval.', at: at() }
      }
      throw error
    }).finally(() => { this.creating.delete(binding.id); this.rotating.delete(binding.id) })
    this.creating.set(binding.id, run)
    return run
  }
  private hydrate(binding: Binding): Promise<ManagedAgent> {
    const existing = this.context.agents.get(binding.id); if (existing instanceof ManagedAgent) return Promise.resolve(existing)
    const transport = { enqueue: (message: UserMessage, mode: 'queue' | 'steer') => this.enqueue(binding.id, message, mode),
      notice: (message: UserMessage) => this.notice(binding.id, message), cancel: (keep: boolean) => this.cancel(binding.id, keep),
      pending: (mode: 'queue' | 'steer') => this.state.list('delivery', binding.id)
        .filter(row => row.mode === mode && !!(row.queuedAt || row.acceptedAt) && !row.consumedAt && !row.removedAt).map(row => row.message),
      remove: (id: string) => { const row = this.state.get('delivery', `${binding.id}:${id}`); if (!row || row.consumedAt) return false; this.state.put('delivery', row.id, { ...row, removedAt: at() }); return true } }
    const agent = new ManagedAgent(binding.id, this.context, this.state, { agentPreset: binding.role === 'orchestrator' ? 'dsh-superagent-router' : 'dsh-superagent-worker', parentSession: binding.parent }, binding.model, transport)
    this.context.agents.set(binding.id, agent)
    return this.context.parallel('agent/created', { agent }).then(() => agent)
  }
  private async ensureRemote(initial: Binding): Promise<ManagedAgent> {
    await this.ready
    await this.cancelling.get(initial.id)
    this.host.lifetime.throwIfAborted()
    let binding = this.binding(initial.id)
    if (binding.identityError) throw new Error('The original Paseo conversation identity requires operator repair')
    binding = this.refreshGeneration(binding)
    if (binding.serverId && this.serverId && binding.serverId !== this.serverId) throw new Error('The persisted conversation belongs to a different Paseo server')
    const agent = await this.hydrate(binding)
    let snapshot: AgentSnapshotPayload | undefined
    let canSwitch = !binding.createdRemote
    if (binding.createdRemote) {
      const canReplaceUnavailable = binding.role === 'orchestrator' && !!this.replacementProfile(binding) && this.canReplace(binding)
        && (acceptsTurn(binding.status) || binding.status === 'closed')
      snapshot = await this.client.fetchAgent(binding.agentId).then(result => result?.agent, (error: unknown) => {
        if (!canReplaceUnavailable) throw error
        return undefined
      })
      if (snapshot) {
        if (changedIdentity(binding, snapshot) || snapshot.id !== binding.agentId) {
          if (snapshot.id === binding.agentId) this.acceptSnapshot(binding.id, snapshot)
          throw new Error('The original Paseo conversation identity changed')
        }
        if (binding.nativeSessionId && !snapshot.persistence?.sessionId) throw new Error('The original Paseo native identity is unavailable')
        const history = await this.syncTimeline(binding)
        binding = this.binding(binding.id)
        canSwitch = idleForReplacement(snapshot) && (!history.snapshot || idleForReplacement(history.snapshot))
      } else {
        if (!canReplaceUnavailable) throw new Error('The persisted Paseo agent is missing; refusing to clone the conversation')
        canSwitch = true
      }
    }

    const selection = this.replacementProfile(binding)
    let replacement = this.state.get('replacement', binding.id)
    if (replacement && (!selection || this.replacementProfile(replacement))) {
      this.capabilities.delete(replacement.capabilityHash)
      const discarded = replacement
      this.state.atomic(() => {
        this.queueRetirement(discarded, discarded.agentId)
        this.state.delete('replacement', binding.id)
      })
      replacement = undefined
    }
    if (selection && canSwitch && this.canReplace(binding)) {
      const launch = await this.switchProfile(binding, selection, agent, replacement, snapshot)
      if (launch) {
        binding = launch.binding
        snapshot = launch.snapshot
      }
    } else if (!binding.createdRemote) {
      snapshot = await this.launchRemote(binding, 'binding')
      const current = this.binding(binding.id)
      if (current.closed) {
        await this.archiveRemote(binding.agentId)
        throw new Error('The parent stopped while its child was being created')
      }
      binding = this.confirmCreation(current, snapshot)
      this.state.atomic(() => { binding = this.saveCreatedBinding(binding) })
      this.toolSignals.set(binding.id, new AbortController())
      agent.session.append('model/selection', binding.model)
      if (!this.host.lifetime.aborted) await this.syncTimeline(binding)
    }
    if (!snapshot) throw new Error('The selected Paseo Profile is awaiting a working conversation')
    if (binding.role === 'orchestrator' && snapshot.status === 'closed') throw new Error('The main Paseo conversation is closed')
    if (binding.previousAgentId) this.state.atomic(() => { binding = this.saveCreatedBinding(this.binding(binding.id)) })
    if (!this.toolSignals.has(binding.id)) this.toolSignals.set(binding.id, new AbortController())
    this.acceptSnapshot(binding.id, snapshot, true)
    if (binding.role === 'orchestrator' && !this.replacementProfile(binding)) this.mainProblem = undefined
    await this.archiveRetirements(binding.id)
    return agent
  }
  private async switchProfile(binding: Binding, selection: RoleModel, agent: ManagedAgent, pending?: Binding, original?: AgentSnapshotPayload) {
    this.rotating.add(binding.id)
    const replacement = pending ?? this.reserveBinding({ id: binding.id, cwd: binding.cwd, role: binding.role, ticketId: binding.ticketId,
      parent: binding.parent, assignmentId: binding.assignmentId, generation: binding.generation }, selection, 'replacement')
    let snapshot: AgentSnapshotPayload
    try {
      snapshot = await this.launchRemote(replacement, 'replacement', original?.title ?? undefined)
    } catch (error) {
      if (!original || original.status === 'closed' || binding.role !== 'orchestrator') throw error
      // Settings reports the failed selection while the working session stays bound.
      return
    }
    if (this.host.lifetime.aborted || this.replacementProfile(replacement)) return
    if (original) {
      // A turn started directly in Paseo while creation was in flight still belongs to the old session.
      const history = await this.syncTimeline(binding)
      if (history.snapshot && !idleForReplacement(history.snapshot)) return
    }
    const current = this.binding(binding.id)
    if (this.host.lifetime.aborted || this.replacementProfile(replacement) || this.cancelling.has(binding.id)
      || current.agentId !== binding.agentId || current.closed || current.identityError || current.resumeEpoch !== binding.resumeEpoch) return

    const prepared = this.state.get('replacement', binding.id)!
    const next = this.confirmCreation(prepared, snapshot)
    this.activateReplacement(current, next)
    agent.session.append('model/selection', next.model)
    await this.syncTimeline(next)
    return { binding: next, snapshot }
  }
  private confirmCreation(binding: Binding, snapshot: AgentSnapshotPayload): Binding {
    return { ...binding, createdRemote: true, workspaceId: snapshot.workspaceId, nativeSessionId: snapshot.persistence?.sessionId, serverId: this.serverId }
  }
  private async launchRemote(binding: Binding, kind: 'binding' | 'replacement', title?: string) {
    try {
      const wrapperDirectory = this.writeToolWrapper(binding)
      mkdirSync(binding.cwd, { recursive: true })
      const effective = this.snapshot(binding), body = snapshotBody(effective)
      if (!binding.contextRevision) {
        binding = { ...binding, contextRevision: sha256(body), contextPromptRevision: effective.promptRevision }
        this.state.put(kind, binding.id, binding)
      }
      const commands = commandEnvironment(this.commandEnvironment(binding))
      const isolation = Object.fromEntries(Object.entries(commands).filter(([name]) => sessionEnvironment.has(name)))
      const snapshot = await this.client.createAgent({ agentId: binding.agentId, idempotencyKey: `superagent:${binding.agentId}`, ...binding.model, cwd: binding.cwd,
        title: this.sessionTitle(title ?? (binding.role === 'orchestrator' ? 'Superagent orchestrator' : `Superagent ${binding.ticketId ?? 'child'}`)),
        ...(binding.parent ? { callerAgentId: this.binding(binding.parent).agentId } : {}),
        systemPrompt: contextBlock(body) + '\n\n' + this.toolInstructions(binding),
        env: { ...isolation, SUPERAGENT_CONTROL_FILE: binding.file, PATH: [wrapperDirectory, commands.PATH ?? ''].join(delimiter) } })
      if (snapshot.id !== binding.agentId || changedIdentity(binding, snapshot)) throw new Error('Paseo returned a different conversation identity')
      if (binding.role === 'orchestrator' && (snapshot.status === 'error' || snapshot.status === 'closed')) throw new Error('Paseo returned a failed main session')
      return snapshot
    } catch (error) {
      if (binding.role === 'orchestrator') {
        this.mainProblem = { detail: `Paseo could not create the main session for Profile "${binding.profile?.name}" (${binding.provider}). Check the Profile in Paseo or select another in Settings → Eval.`, at: at() }
      }
      throw error
    }
  }
  private replacementProfile(binding: Binding): RoleModel | undefined {
    if (binding.role === 'worker' && binding.profile) return
    const selected = this.roleProfile(binding.role)
    if (!binding.profile || selected.profileId !== binding.profile.profileId || !isDeepStrictEqual(launchConfig(selected), launchConfig(binding.profile))) return selected
  }
  private canReplace(binding: Binding): boolean {
    return !this.submitting.has(binding.id) && !this.cancelling.has(binding.id) && !this.rotating.has(binding.id)
      && ![...this.sending.keys()].some(key => key.startsWith(binding.id + ':'))
      && !this.jobs.list(binding.id).some(job => ['reserved', 'running', 'stopping'].includes(job.state))
  }
  private activateReplacement(binding: Binding, next: Binding): void {
    this.state.atomic(() => {
      this.state.put('binding', binding.id, next)
      this.state.delete('replacement', binding.id)
      this.queueRetirement(binding, binding.agentId)
      if (binding.previousAgentId) this.queueRetirement(binding, binding.previousAgentId)
      for (const row of this.state.list('delivery', binding.id)) {
        if (row.removedAt || row.finishedAt) continue
        if (row.acceptedAt || row.consumedAt) this.state.put('delivery', row.id, { ...row, removedAt: at(),
          error: row.consumedAt ? undefined : 'The archived Paseo conversation did not confirm this input' })
        else this.state.put('delivery', row.id, { ...row, remoteId: stableId(`input:${next.agentId}:${row.message.id}`), body: messageBody(row.message), attempt: undefined,
          queueEpoch: 0, promptRevision: undefined, contextRevision: undefined, noticeIds: undefined })
      }
    })
    this.invalidate(binding.id)
    this.capabilities.delete(binding.capabilityHash)
    this.toolSignals.set(binding.id, new AbortController())
  }
  private saveCreatedBinding(binding: Binding): Binding {
    if (binding.previousAgentId) this.queueRetirement(binding, binding.previousAgentId)
    const next = { ...binding, previousAgentId: undefined }
    this.state.put('binding', next.id, next)
    return next
  }
  private queueRetirement(binding: Binding, agentId: string): void {
    this.state.put('retirement', agentId, { id: agentId, owner: binding.id, serverId: binding.serverId })
  }
  private async archiveRemote(agentId: string): Promise<void> {
    const old = (await this.client.fetchAgent(agentId))?.agent
    if (!old || old.archivedAt) return
    if (old.id !== agentId) throw new Error('Paseo returned a different conversation identity during archival')
    if (old.status !== 'closed') await this.client.cancelAgent(agentId)
    await this.client.archiveAgent(agentId)
  }
  private async archiveRetirements(owner: string): Promise<void> {
    for (const retirement of this.state.list('retirement', owner)) {
      if (this.host.lifetime.aborted || retirement.serverId && this.serverId && retirement.serverId !== this.serverId) return
      try {
        await this.archiveRemote(retirement.id)
        this.archiveFailures.delete(retirement.id)
        this.state.delete('retirement', retirement.id)
      } catch {
        if (!this.archiveFailures.has(retirement.id)) this.context.logger.warn('Paseo could not archive a superseded session. Superagent will retry cleanup.')
        this.archiveFailures.add(retirement.id)
      }
    }
  }
  private toolInstructions(binding: Binding): string {
    const tools = managedToolDefinitions(this, binding).map(tool => `- ${tool.name} — ${tool.description}`).join('\n')
    return [
      'Use your shell to run Superagent application tools with `superagent-tool`. Run `superagent-tool list` to see schemas.',
      'Use superagent_shell for commands that need the project credentials or background job tracking.',
      "Call a tool with `superagent-tool call <tool_name> '<json>'`. For multiline input or embedded quotes, pass JSON through stdin.",
      "Example:\n\`\`\`sh\nsuperagent-tool call orchestrator_read --stdin <<'JSON'\n{\"resource\":\"prompts/current\"}\nJSON\n\`\`\`",
      'Read the returned content and structuredContent. A nonzero exit code indicates that the call failed.',
      'Available tools:\n' + tools,
    ].join('\n\n')
  }
  private refreshGeneration(binding: Binding): Binding {
    if (!binding.ticketId || binding.parent) return binding
    const ticket = this.host.store.tickets.get(binding.ticketId), assignmentId = ticket && latestAssignment(ticket)?.id
    if (!assignmentId || assignmentId === binding.assignmentId) return binding
    const owners = new Set([binding.id, ...this.children(binding.id).map(child => child.id)])
    if (this.state.list('execution').some(work => owners.has(work.owner) && work.assignmentId === binding.assignmentId
      && ['reserved', 'running', 'stopping'].includes(work.state))) throw new Error('Previous assignment owned work must finish cleanup before replacement')
    const next = { ...binding, assignmentId, generation: binding.generation + 1 }
    this.invalidate(binding.id)
    this.state.atomic(() => {
      this.state.put('binding', binding.id, next)
      for (const delivery of this.state.list('delivery', binding.id)) if (!delivery.consumedAt) {
        if (delivery.message.source.kind === 'tool-jobs') {
          this.state.put('delivery', delivery.id, { ...delivery, removedAt: at() })
          const workId = delivery.message.id.startsWith('job-ended:') ? delivery.message.id.slice('job-ended:'.length) : undefined
          const work = workId && this.state.get('execution', workId)
          if (work) this.state.put('execution', work.id, { ...work, notification: 'discarded' })
        } else this.state.put('delivery', delivery.id, { ...delivery, generation: next.generation, assignmentId, queueEpoch: next.resumeEpoch ?? 0 })
      }
    })
    return next
  }
  assertBinding(binding: Binding): void {
    if (this.closing || binding.closed || this.host.lifetime.aborted) throw new Error('Application execution is stopped')
    const current = this.binding(binding.id)
    if (binding.identityError || current.identityError) throw new Error('The original Paseo conversation identity changed')
    if (current.closed || current.status === 'closed' || current.agentId !== binding.agentId || current.generation !== binding.generation
      || current.assignmentId !== binding.assignmentId) throw new Error('Stale assignment capability')
    if (!binding.ticketId) return
    const ticket = this.host.store.tickets.get(binding.ticketId)
    if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended; new work needs a new authorized ticket')
    if (latestAssignment(ticket)?.id !== binding.assignmentId) throw new Error('Stale assignment capability')
    if (binding.parent) {
      const parent = this.binding(binding.parent)
      if (parent.generation !== binding.generation || parent.assignmentId !== binding.assignmentId) throw new Error('Stale parent assignment capability')
      this.assertBinding(parent)
    }
  }
  private invalidate(owner: string): void {
    const controller = this.toolSignals.get(owner) ?? new AbortController()
    this.toolSignals.set(owner, controller)
    controller.abort(new Error('Application tool request was cancelled'))
  }
  async authorize(binding: Binding, name: string, args: unknown): Promise<string | undefined> {
    try {
      this.assertBinding(binding)
      const tools = this.agent(binding.id).tools
      if (!tools.get(name) && !controlToolNames(binding.role).some(control => control === name)) return 'Unknown or unmanaged tool entry'
      const refusal = await tools.authorize(name, args)
      this.assertBinding(binding)
      return refusal
    } catch (error) { return error instanceof Error ? error.message : 'Session capability is no longer valid' }
  }
  async modelCatalog(): Promise<ModelCatalog> {
    const [daemon, availability] = await Promise.allSettled([
      this.ready.then(() => this.client.getDaemonConfig()),
      this.ready.then(() => this.client.listAvailableProviders()),
    ])
    const failures: { id: string; name: string; message: string }[] = []
    if (daemon.status === 'rejected') failures.push({ id: 'profiles', name: 'Paseo', message: 'Could not read Agent Profiles from the Paseo daemon.' })
    const providers = availability.status === 'fulfilled' && !availability.value.error ? availability.value.providers : undefined
    if (!providers) failures.push({ id: 'providers', name: 'Paseo', message: 'Could not check which Paseo providers are available.' })
    const profiles = daemon.status === 'fulfilled' ? daemon.value.config.agentProfiles ?? [] : []
    return { failures, profiles: profiles.flatMap(profile => {
      const parsed = RoleModelSchema.safeParse({ profileId: profile.id, name: profile.name, provider: profile.provider,
        model: nonempty(profile.model), modeId: nonempty(profile.modeId), thinkingOptionId: nonempty(profile.thinkingOptionId), featureValues: profile.featureValues })
      return parsed.success ? [{ ...parsed.data, available: providers?.some(provider => provider.provider === profile.provider && provider.available) ?? false }] : []
    }) }
  }
  commandEnvironment(binding: Binding): Record<string, string | undefined> {
    const variables = binding.ticketId ? this.host.ticketEnvironment(this.host.store.tickets.get(binding.ticketId)!) : []
    const setup = this.host.setup.commandEnvironment
    return { ...setup, ...Object.fromEntries(variables.map(variable => [variable.key, variable.value])),
      GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1', PATH: [workerBin(this.config.stateDir), setup.PATH ?? ''].join(delimiter) }
  }
  private async remoteHolds(binding: Pick<Binding, 'agentId'>, remoteId: string): Promise<boolean> {
    let cursor: { epoch: string; seq: number } | undefined
    for (;;) {
      const page = await this.client.fetchAgentTimeline(binding.agentId, { limit: 500, ...(cursor ? { cursor, direction: 'before' } : {}) })
      if (page.error) throw new Error('Paseo message history is unavailable')
      if (page.entries.some(entry => entry.item.type === 'user_message' && (entry.item.clientMessageId === remoteId || entry.item.messageId === remoteId))) return true
      if (!page.hasOlder || !page.startCursor) return false
      if (cursor && cursor.epoch === page.startCursor.epoch && cursor.seq === page.startCursor.seq) throw new Error('Paseo history cursor did not advance')
      cursor = page.startCursor
    }
  }
  /** Use this instance's authenticated daemon transport for its configured Source outbox as well. */
  async sendSourceNotice(message: OutboundMessage): Promise<'sent'> {
    const agentId = message.channel.address.agentId
    if (!agentId || !PASEO_AGENT_ID.test(agentId)) throw new Error('Invalid Paseo notification destination')
    const remoteId = stableId(`source-notice:${message.id}`)
    try {
      if (!await this.remoteHolds({ agentId }, remoteId)) await this.client.sendAgentMessage(agentId, paseoNotification(message), { messageId: remoteId, activeTurnBehavior: 'steer' })
      return 'sent'
    } catch { throw new Error('Paseo notification delivery failed; check the configured local daemon') }
  }
  /** Receipt deduplication must still let a retry reach the original delivery's execution state. */
  async retryDelivery(owner: string, id: string): Promise<void> {
    const row = this.state.get('delivery', `${owner}:${id}`)
    if (row && !row.removedAt && !row.finishedAt) await this.enqueue(owner, row.message, row.mode)
  }
  private async enqueue(owner: string, message: UserMessage, mode: 'queue' | 'steer'): Promise<void> {
    const key = `${owner}:${message.id}`, previous = this.sending.get(key) ?? Promise.resolve()
    const sending = previous.catch(() => {}).then(async () => {
      if (mode !== 'queue') return this.sendDelivery(owner, message, mode)
      const ahead = this.queueSends.get(owner) ?? Promise.resolve()
      const queued = ahead.catch(() => {}).then(() => this.sendDelivery(owner, message, mode))
      this.queueSends.set(owner, queued)
      try { await queued } finally { if (this.queueSends.get(owner) === queued) this.queueSends.delete(owner) }
    })
    this.sending.set(key, sending)
    try { await sending } finally { if (this.sending.get(key) === sending) this.sending.delete(key) }
  }
  private async sendDelivery(owner: string, message: UserMessage, mode: 'queue' | 'steer'): Promise<void> {
    if (this.rotating.has(owner)) await this.creating.get(owner)
    let binding = this.refreshGeneration(this.binding(owner)); this.assertBinding(binding)
    const assigned = binding
    const id = `${owner}:${message.id}`, existing = this.state.get('delivery', id)
    if (existing && (existing.consumedAt || existing.acceptedAt && !existing.removedAt)) {
      if (existing.removedAt || existing.finishedAt || existing.generation !== binding.generation || existing.assignmentId !== binding.assignmentId) return
      const history = await this.syncTimeline(binding)
      await this.wakeInterrupted(binding, existing, history, false)
      return
    }
    const row: Delivery = { ...existing, id, owner, assignmentId: binding.assignmentId, generation: binding.generation,
      remoteId: existing?.remoteId ?? stableId(`input:${binding.agentId}:${message.id}`), message: existing?.message ?? message, body: existing?.body ?? messageBody(message), mode,
      createdAt: existing?.createdAt ?? at(), removedAt: undefined,
      ...(mode === 'queue' ? { queuedAt: existing?.queuedAt ?? at(), queueEpoch: binding.resumeEpoch ?? 0 } : {}) }
    this.state.put('delivery', id, row)
    if (!this.cancelling.has(owner) && acceptsTurn(this.agent(owner).status)) {
      // A new authorized input resumes a kept inbox; cancel alone never restarts its old queued turn.
      for (const queued of this.state.list('delivery', owner)) if (queued.mode === 'queue' && queued.queuedAt && !queued.acceptedAt && !queued.consumedAt && !queued.removedAt
        && queued.generation === binding.generation && (queued.queueEpoch ?? 0) !== (binding.resumeEpoch ?? 0)) {
        this.state.put('delivery', queued.id, { ...queued, queueEpoch: binding.resumeEpoch ?? 0 })
      }
    }
    if (mode === 'queue') {
      if (this.cancelling.has(owner) || this.submitting.has(owner)) return
      const fresh = (await this.client.fetchAgent(binding.agentId))?.agent
      if (!fresh) throw new Error('The original Paseo conversation is unavailable')
      this.acceptSnapshot(owner, fresh, true)
      if (this.cancelling.has(owner) || !acceptsTurn(this.agent(owner).status)) return
      const first = this.state.list('delivery', owner).find(queued => queued.mode === 'queue' && queued.queuedAt && !queued.acceptedAt && !queued.consumedAt && !queued.removedAt
        && queued.generation === binding.generation && (queued.queueEpoch ?? 0) === (binding.resumeEpoch ?? 0))
      if (first && first.id !== id) { void this.flushQueued(owner, true); return }
    }
    // Check the remote history even when a previous send failed before the local receipt committed.
    const history = await this.syncTimeline(binding)
    const { held, ambiguous, snapshot } = history
    this.assertBinding(assigned)
    binding = this.binding(owner); this.assertBinding(binding)
    if (this.cancelling.has(owner) || (assigned.resumeEpoch ?? 0) !== (binding.resumeEpoch ?? 0)) return
    if (held.has(row.remoteId) && snapshot && acceptsTurn(snapshot.status) && !this.submitting.has(owner)) {
      this.acceptSnapshot(owner, snapshot, true)
    }
    if (mode === 'queue' && (!acceptsTurn(this.agent(owner).status) || (row.queueEpoch ?? 0) !== (binding.resumeEpoch ?? 0))) return
    if (binding.handedBack && message.source.kind === 'tool-jobs') {
      this.state.put('delivery', id, { ...this.state.get('delivery', id)!, removedAt: at() })
      return
    }
    if (binding.handedBack) { binding = { ...binding, handedBack: false }; this.state.put('binding', owner, binding) }
    const present = held.has(row.remoteId)
    const latest = this.state.get('delivery', id)!
    if (latest.consumedAt || latest.removedAt) return
    if (!present) {
      if (ambiguous.has(row.remoteId) || latest.acceptedAt) {
        throw new Error('The original Paseo input outcome is awaiting identity evidence')
      }
      // Reuse the daemon's receipt key if the first send ended before it acknowledged.
      const send = latest.attempt ? latest : this.withContext(binding, latest)
      this.state.put('delivery', id, send)
      if (history.epoch) this.recordAttempt(binding, send, row.remoteId, history.epoch, true)
      await this.submit(binding, row.remoteId, send.body)
      await this.options.afterRemoteSend?.(send)
      this.recordSentContext(binding, send)
    } else await this.wakeInterrupted(binding, latest, history, false)
    this.state.atomic(() => {
      const current = this.state.get('delivery', id)!
      this.state.put('delivery', id, { ...current, acceptedAt: current.acceptedAt ?? at(), error: undefined,
        attempt: current.attempt?.id === row.remoteId ? { ...current.attempt, pending: undefined } : current.attempt })
      if (message.source.kind === 'tool-jobs' && message.id.startsWith('job-ended:')) {
        const work = this.state.get('execution', message.id.slice('job-ended:'.length))
        if (work) this.state.put('execution', work.id, { ...work, notification: 'delivered' })
      }
    })
  }
  private withContext(binding: Binding, row: Delivery): Delivery {
    const effective = this.snapshot(binding), body = snapshotBody(effective), revision = sha256(body)
    const text = row.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    return { ...row, body: revision === binding.contextRevision ? row.body : deliveryBody(row.message.id, contextBlock(body) + '\n\n' + text),
      contextRevision: revision, promptRevision: effective.promptRevision, noticeIds: effective.notices.map(notice => notice.id) }
  }
  private recordSentContext(binding: Binding, delivery: Pick<Delivery, 'contextRevision' | 'promptRevision'>): void {
    const current = this.binding(binding.id)
    if (delivery.contextRevision && current.agentId === binding.agentId && current.contextRevision === binding.contextRevision) {
      this.state.put('binding', binding.id, { ...current, contextRevision: delivery.contextRevision, contextPromptRevision: delivery.promptRevision })
    }
  }
  private recordAttempt(binding: Binding, row: Delivery, id: string, timelineEpoch: string, pending?: boolean): void {
    const current = this.state.get('delivery', row.id)!
    this.state.put('delivery', row.id, { ...current, attempt: { id, timelineEpoch, resumeEpoch: binding.resumeEpoch ?? 0, pending }, error: undefined })
  }
  private async wakeInterrupted(binding: Binding, row: Delivery, history: DeliveryHistory, automatic: boolean): Promise<boolean> {
    const { snapshot, epoch, held, ambiguous } = history, owner = binding.id
    this.assertBinding(binding)
    const current = this.binding(owner)
    const latest = this.state.get('delivery', row.id)
    if (!latest || latest.removedAt || latest.finishedAt || current.handedBack || this.cancelling.has(owner) || this.submitting.has(owner)
      || current.resumeEpoch !== binding.resumeEpoch || !snapshot || snapshot.activeTurn || !acceptsTurn(snapshot.status)) return false
    const resumeEpoch = current.resumeEpoch ?? 0
    const afterShutdown = latest.attempt?.resumeAfterShutdown === resumeEpoch
    if (latest.attempt && latest.attempt.resumeEpoch !== resumeEpoch && !afterShutdown && (automatic || latest.consumedAt)) return false
    if (automatic && (snapshot.status !== 'idle' || !latest.attempt || latest.attempt.timelineEpoch === epoch && !afterShutdown && !latest.attempt.pending)) return false

    const defer = (error: string): false => {
      if (latest.error !== error) {
        this.state.put('delivery', latest.id, { ...latest, error })
        this.context.logger.warn('%s (%s)', error, latest.id)
      }
      if (!automatic) throw new Error(error)
      return false
    }
    if (!epoch || !held.has(latest.remoteId)) return defer('The original Paseo input outcome is awaiting identity evidence')
    const prior = latest.attempt?.id && history.turns.get(latest.attempt.id)
    const outcome = prior ?? history.turns.get(latest.remoteId)
    if (outcome === 'reply') {
      this.state.put('delivery', latest.id, { ...latest, finishedAt: at(), error: undefined })
      return false
    }
    if (outcome === 'tool') {
      return defer('Check tool effects in the original Paseo conversation before continuing this interrupted input')
    }
    if (!outcome) return defer('The original Paseo input outcome is awaiting timeline evidence')
    // A different daemon timeline gets its own wake ID. In one epoch, retries reuse the durable reservation.
    const continuation = stableId(`continue:recovery:${latest.remoteId}:${binding.generation}:${resumeEpoch}:${epoch}`)
    if (ambiguous.has(continuation)) return defer('The original Paseo continuation is awaiting identity evidence')
    if (held.has(continuation)) {
      if (!automatic) throw new Error('The last continuation ended before a final reply in the original Paseo conversation')
      return false
    }
    this.state.atomic(() => {
      const id = `internal-message:${continuation}`
      this.state.put('value', id, { id, value: owner })
      this.recordAttempt(current, latest, continuation, epoch, true)
    })
    await this.submit(current, continuation, deliveryBody(continuation, recoveryPrompt))
    const acknowledged = this.state.get('delivery', latest.id)
    if (acknowledged?.attempt?.id === continuation) {
      this.state.put('delivery', latest.id, { ...acknowledged, attempt: { ...acknowledged.attempt, pending: undefined } })
    }
    return true
  }
  private async flushInterrupted(binding: Binding, history: DeliveryHistory): Promise<void> {
    const { epoch, snapshot } = history
    if (!this.callbacksReady || this.closing || this.host.lifetime.aborted || this.host.store.settings().paused || !epoch || snapshot?.status !== 'idle') return
    const resumeEpoch = binding.resumeEpoch ?? 0
    const rows = this.state.list('delivery', binding.id).filter(row => row.attempt
      && (row.attempt.resumeAfterShutdown === resumeEpoch || row.attempt.resumeEpoch === resumeEpoch && (row.attempt.timelineEpoch !== epoch || row.attempt.pending))
      && row.acceptedAt && !row.finishedAt && !row.removedAt && !row.error
      && row.message.source.kind === 'dsh-superagent' && row.generation === binding.generation && row.assignmentId === binding.assignmentId)
    if (!rows.length) return
    for (const row of rows) {
      if (this.sending.has(row.id)) continue
      if (await this.wakeInterrupted(binding, row, history, true)) return
    }
  }
  private async submit(binding: Binding, messageId: string, body: string): Promise<void> {
    const owner = binding.id
    this.submitting.set(owner, (this.submitting.get(owner) ?? 0) + 1)
    try {
      if (this.toolSignals.get(owner)?.signal.aborted) this.toolSignals.set(owner, new AbortController())
      this.agent(owner).status = 'running'
      await this.client.sendAgentMessage(binding.agentId, body, { messageId, activeTurnBehavior: 'steer' })
    } finally {
      const remaining = this.submitting.get(owner)! - 1
      if (remaining) this.submitting.set(owner, remaining)
      else this.submitting.delete(owner)
    }
  }
  /** Queue receipts acknowledge local persistence; the original daemon is contacted only after this owner's turn is idle. */
  private async flushQueued(owner: string, explicitRetry = false): Promise<void> {
    if (!this.callbacksReady || this.closing || this.host.lifetime.aborted || this.flushing.has(owner) || this.cancelling.has(owner)) return
    const status = this.context.agents.get(owner)?.status
    if (status !== 'idle' && !(explicitRetry && status === 'error')) return
    const binding = this.binding(owner)
    if (binding.closed || binding.identityError) return
    const row = this.state.list('delivery', owner).find(row => row.mode === 'queue' && row.queuedAt && !row.acceptedAt && !row.consumedAt && !row.removedAt
      && row.generation === binding.generation && (row.queueEpoch ?? 0) === (binding.resumeEpoch ?? 0))
    if (!row) return
    this.flushing.add(owner)
    try { await this.enqueue(owner, row.message, 'queue') }
    catch { const current = this.state.get('delivery', row.id); if (current) this.state.put('delivery', row.id, { ...current, error: 'Queued input is awaiting its original Paseo conversation' }) }
    finally { this.flushing.delete(owner) }
  }
  private async notice(owner: string, message: UserMessage): Promise<void> {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const id = `${owner}:${message.id}`
    if (this.state.get('notice', id)) return
    const source = message.source as UserMessage['source'] & { mergeKey?: string }
    this.state.atomic(() => {
      if (source.mergeKey) for (const previous of this.state.list('notice', owner)) {
        // Replace this key's current projection, retaining the older receipt for history and any in-flight ACK.
        if (previous.mergeKey === source.mergeKey && !previous.supersededAt) this.state.put('notice', previous.id, { ...previous, supersededAt: at() })
      }
      const notice: Notice = { id, owner, text, summary: source.summary ?? 'Runtime notice', mergeKey: source.mergeKey,
        order: this.state.list('notice', owner).length, createdAt: at() }
      this.state.put('notice', id, notice)
    })
  }
  private cancel(owner: string, keepInbox: boolean): Promise<void> {
    // Revoke synchronously, then make any replacement generation wait for the remote turn to stop.
    this.invalidate(owner)
    const previous = this.cancelling.get(owner) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => this.cancelRemote(owner, keepInbox))
    this.cancelling.set(owner, pending)
    void pending.finally(() => { if (this.cancelling.get(owner) === pending) this.cancelling.delete(owner) }).catch(() => {})
    return pending
  }
  private async cancelRemote(owner: string, keepInbox: boolean): Promise<void> {
    const binding = this.binding(owner); this.invalidate(owner)
    this.state.atomic(() => {
      const resumeEpoch = (binding.resumeEpoch ?? 0) + 1
      this.state.put('binding', owner, { ...binding, resumeEpoch })
      // Ordered process shutdown stops the main turn, but the next process still owns its authorized input.
      if (keepInbox && this.host.lifetime.aborted && binding.role === 'orchestrator') {
        for (const row of this.state.list('delivery', owner)) if (row.attempt && !row.removedAt && !row.finishedAt
          && (row.attempt.resumeEpoch === resumeEpoch - 1 || row.attempt.resumeAfterShutdown === resumeEpoch - 1)) {
          this.state.put('delivery', row.id, { ...row, attempt: { ...row.attempt, resumeAfterShutdown: resumeEpoch } })
        }
      }
      if (!keepInbox) for (const row of this.state.list('delivery', owner)) if (!row.consumedAt) this.state.put('delivery', row.id, { ...row, removedAt: at() })
    })
    if (binding.createdRemote) await this.client.cancelAgent(binding.agentId)
    const deadline = Date.now() + 10_000
    while (binding.createdRemote) {
      const snapshot = (await this.client.fetchAgent(binding.agentId))?.agent
      if (!snapshot) throw new Error('The original Paseo agent is unavailable during cancellation')
      this.acceptSnapshot(owner, snapshot)
      if (acceptsTurn(snapshot.status) || snapshot.status === 'closed') {
        // A current fetch is authoritative even if an identical persisted timestamp hid a cancelled local enqueue.
        this.agent(owner).status = snapshot.status
        break
      }
      if (Date.now() >= deadline) throw new Error('The original Paseo turn did not stop; replacement assignment was refused')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  private queueUpdate(owner: string, snapshot: AgentSnapshotPayload, recover = false): Promise<void> {
    const previous = this.updates.get(owner) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      if (!this.context.agents.has(owner) || this.closing) return
      const binding = this.binding(owner)
      let history: DeliveryHistory | undefined
      if (snapshot.id !== binding.agentId || !binding.createdRemote || this.rotating.has(owner)) return
      if (!binding.identityError && !changedIdentity(binding, snapshot) && !this.host.lifetime.aborted) {
        history = await this.syncTimeline(binding)
      }
      this.acceptSnapshot(owner, snapshot)
      if (recover && history && !this.replacementProfile(binding)) await this.flushInterrupted(binding, history)
    }).catch(() => { /* Polling repairs transient subscription/history failures. */ })
    this.updates.set(owner, work)
    return work
  }
  private acceptSnapshot(owner: string, snapshot: AgentSnapshotPayload, confirmed = false): void {
    const binding = this.binding(owner), agent = this.context.agents.get(owner)
    if (!(agent instanceof ManagedAgent) || binding.closed || snapshot.id !== binding.agentId) return
    const identityError = changedIdentity(binding, snapshot)
    if (identityError || binding.identityError) {
      this.invalidate(owner)
      this.state.put('binding', owner, { ...binding, identityError: identityError ?? binding.identityError, status: 'error', remoteUpdatedAt: snapshot.updatedAt })
      agent.status = 'error'
      this.context.emit('agent/error', { agent, error: new Error('The original Paseo conversation identity changed; execution was revoked') })
      return
    }
    if (binding.remoteUpdatedAt && snapshot.updatedAt < binding.remoteUpdatedAt) return
    if (snapshot.updatedAt === binding.remoteUpdatedAt && snapshot.status === binding.status) {
      // A recovered daemon can report the same saved terminal snapshot after losing an optimistic local send state.
      if (confirmed && acceptsTurn(snapshot.status) && !this.submitting.has(owner)) agent.status = snapshot.status
      return
    }
    const model: ModelSelection = { ...binding.model, model: snapshot.model ?? binding.model.model,
      thinkingOptionId: snapshot.thinkingOptionId ?? binding.model.thinkingOptionId, modeId: snapshot.currentModeId ?? binding.model.modeId }
    if (!isDeepStrictEqual(model, binding.model)) agent.session.append('model/selection', model)
    this.state.put('binding', owner, { ...binding, status: snapshot.status, model,
      nativeSessionId: binding.nativeSessionId ?? snapshot.persistence?.sessionId, remoteUpdatedAt: snapshot.updatedAt })
    if (snapshot.status === 'closed') this.invalidate(owner)
    agent.status = snapshot.status === 'initializing' ? 'running' : snapshot.status
    if (snapshot.status === 'error') this.context.emit('agent/error', { agent, error: safeProviderFailure(snapshot.lastError) })
    if (binding.parent && (snapshot.status === 'error' || snapshot.status === 'closed')) {
      void this.failChild(owner, snapshot.status).catch(() => { this.context.logger.warn('A failed child still has owned work pending cleanup') })
      return
    }
    const execution = this.state.list('execution').find(item => item.childAlias === owner && ['reserved', 'running'].includes(item.state))
    if (execution?.state === 'reserved' && snapshot.status === 'running') this.state.put('execution', execution.id, { ...execution, state: 'running' })
    if (execution && snapshot.status === 'idle') this.settleChild(owner)
    if (snapshot.status === 'idle') void this.flushQueued(owner)
  }
  private childBusy(owner: string): boolean {
    return this.state.list('execution').some(item => item.childAlias === owner && ['reserved', 'running', 'stopping'].includes(item.state))
  }
  private wakeChildWaiters(owner: string): void { for (const wake of this.childWaiters.get(owner) ?? []) wake(); this.childWaiters.delete(owner) }
  private settleChild(owner: string): void {
    const binding = this.binding(owner)
    if (binding.closed || this.childrenClosing.has(owner) || this.context.agents.get(owner)?.status !== 'idle') return
    if (this.jobs.list(owner).some(job => ['reserved', 'running', 'stopping'].includes(job.state)) || this.children(owner).some(child => this.childBusy(child.id))) return
    const execution = this.state.list('execution').find(item => item.childAlias === owner && ['reserved', 'running'].includes(item.state))
    if (!execution) return
    if (execution.state === 'reserved' && !this.state.list('delivery', owner).some(row => row.acceptedAt || row.consumedAt)) return
    const complete: OwnedExecution = { ...execution, state: 'completed', endedAt: at(), notification: 'pending' }
    this.state.put('execution', execution.id, complete)
    // Enqueue the result before releasing the parent's wait so its new turn keeps the slot.
    void this.childEnded(binding, complete).then(disposition => {
      this.state.put('execution', complete.id, { ...this.state.get('execution', complete.id)!, notification: disposition })
    }).catch(() => {}).finally(() => { this.wakeChildWaiters(owner); if (binding.parent) this.settleChild(binding.parent) })
  }
  private failChild(owner: string, status: 'error' | 'closed'): Promise<void> {
    const active = this.failingChildren.get(owner); if (active) return active
    const work = this.cleanupFailedChild(owner, status).finally(() => { this.failingChildren.delete(owner) })
    this.failingChildren.set(owner, work); return work
  }
  private async cleanupFailedChild(owner: string, status: 'error' | 'closed'): Promise<void> {
    const execution = this.state.list('execution').find(item => item.childAlias === owner && ['reserved', 'running', 'stopping'].includes(item.state))
    if (!execution) return
    this.invalidate(owner)
    this.state.put('execution', execution.id, { ...execution, state: 'stopping', failure: status === 'error' ? 'provider-error' : 'provider-closed', cleanupPending: true })
    const jobs = this.jobs.list(owner).filter(job => ['reserved', 'running', 'stopping'].includes(job.state))
    const waits = jobs.map(job => this.jobs.wait(job.id, 10_000, owner))
    for (const job of jobs) this.jobs.kill(job.id, owner)
    await Promise.all(waits)
    if (this.jobs.list(owner).some(job => ['reserved', 'running', 'stopping'].includes(job.state))) throw new Error('Child shell cleanup has not completed')
    await Promise.all(this.state.list('binding').filter(child => child.parent === owner && !child.closed).map(child => this.stopChild(child.id)))
    const complete: OwnedExecution = { ...this.state.get('execution', execution.id)!, state: status === 'error' ? 'failed' : 'killed', endedAt: at(), cleanupPending: false, notification: 'pending' }
    this.state.put('execution', complete.id, complete)
    try {
      const disposition = await this.childEnded(this.binding(owner), complete)
      this.state.put('execution', complete.id, { ...this.state.get('execution', complete.id)!, notification: disposition })
    } finally { this.wakeChildWaiters(owner) }
  }
  private async syncTimeline(binding: Binding): Promise<DeliveryHistory> {
    const held = new Set<string>(), ambiguous = new Set<string>(), turns = new Map<string, TurnEvidence>()
    if (!binding.createdRemote) return { held, ambiguous, turns }
    const pages: TimelinePage[] = []
    let cursor: { epoch: string; seq: number } | undefined
    for (;;) {
      const page: TimelinePage = await this.client.fetchAgentTimeline(binding.agentId, { limit: 500, ...(cursor ? { cursor, direction: 'before' } : {}) })
      if (page.error || page.gap || cursor && (page.staleCursor || page.epoch !== cursor.epoch)
        || page.hasOlder && !page.startCursor) throw new Error('The bound Paseo timeline is unavailable')
      if (page.agentId && page.agentId !== binding.agentId || page.agent && (page.agent.id !== binding.agentId || changedIdentity(binding, page.agent))) {
        if (page.agent?.id === binding.agentId && changedIdentity(binding, page.agent)) this.acceptSnapshot(binding.id, page.agent)
        throw new Error('The original Paseo conversation identity changed')
      }
      if (page.agent && binding.nativeSessionId && !page.agent.persistence?.sessionId) throw new Error('The original Paseo native identity is unavailable')
      pages.unshift(page)
      if (!page.hasOlder || !page.startCursor) break
      if (cursor && cursor.epoch === page.startCursor.epoch && cursor.seq === page.startCursor.seq) throw new Error('Paseo timeline cursor did not advance')
      cursor = page.startCursor
    }
    const current = this.binding(binding.id)
    if (current.closed || current.identityError || current.agentId !== binding.agentId || current.nativeSessionId !== binding.nativeSessionId
      || current.generation !== binding.generation || current.assignmentId !== binding.assignmentId || current.resumeEpoch !== binding.resumeEpoch
      || this.serverId && binding.serverId && binding.serverId !== this.serverId) {
      throw new Error('The bound Paseo timeline changed during reconciliation')
    }
    const agent = this.context.agents.get(binding.id)
    if (!(agent instanceof ManagedAgent)) return { held, ambiguous, turns }
    const deliveries = this.state.list('delivery', binding.id)
    const application = deliveries.filter(row => !directDelivery(row))
    const byRemoteId = new Map(application.map(row => [row.remoteId, row]))
    const byMessageId = new Map(application.map(row => [row.message.id, row]))
    const users = pages.flatMap(page => page.entries.map(entry => entry.item))
      .filter((item): item is TimelineUser => item.type === 'user_message')
    const owners = new Map<TimelineUser, string>()
    const projected = new Map<string, TimelineUser[]>()
    for (const item of users) {
      const remoteId = item.clientMessageId ?? item.messageId
      const delivery = remoteId && byRemoteId.get(remoteId)
      const ref = deliveryReference(item.text)
      const internal = remoteId && this.state.get('value', `internal-message:${remoteId}`)?.value === binding.id
      if (delivery || internal && remoteId && recoveryBody(remoteId, item.text)) {
        owners.set(item, remoteId!)
        held.add(remoteId!)
      } else if (ref) {
        // Rebuilt provider history may have different entry IDs, while the intact delivery frame retains its application ID.
        const original = byMessageId.get(ref.id)
        const continuation = this.state.get('value', `internal-message:${ref.id}`)?.value === binding.id && recoveryBody(ref.id, item.text)
        const id = original?.body === item.text ? original.remoteId : continuation ? ref.id : undefined
        if (!id) continue
        const nativeMessageId = nativeId(item)
        if (original?.nativeMessageId && nativeMessageId && original.nativeMessageId !== nativeMessageId) continue
        if (original?.nativeMessageId && original.nativeMessageId === nativeMessageId) {
          owners.set(item, id)
          held.add(id)
        } else {
          const candidates = projected.get(id) ?? []
          candidates.push(item)
          projected.set(id, candidates)
        }
      }
    }
    for (const [id, candidates] of projected) {
      if (held.has(id)) continue
      if (candidates.length !== 1) {
        ambiguous.add(id)
        continue
      }
      owners.set(candidates[0]!, id)
      held.add(id)
    }
    const directByRemote = new Map<string, Delivery>()
    for (const row of deliveries.filter(directDelivery)) {
      directByRemote.set(row.remoteId, row)
      if (row.nativeMessageId) directByRemote.set(row.nativeMessageId, row)
    }
    const currentTurn = new Set<string>()
    const snapshot = pages.at(-1)?.agent ?? undefined
    let replied = false
    this.state.atomic(() => { for (const page of pages) for (const entry of page.entries) {
      const item = entry.item
      const namespace = binding.profile ? binding.agentId : binding.id
      const identity = `timeline:${namespace}:${page.epoch}:${entry.seqStart}`
      const known = this.state.get('value', identity)
      if (item.type === 'user_message') {
        if (replied) { currentTurn.clear(); replied = false }
        const remoteId = item.clientMessageId ?? item.messageId
        const nativeMessageId = nativeId(item)
        const owned = owners.get(item)
        if (owned) {
          currentTurn.add(owned)
          turns.set(owned, 'input')
          const original = byRemoteId.get(owned)
          if (original) {
            const row = this.state.get('delivery', original.id)!
            this.recordConsumption(current, agent, { ...row, nativeMessageId: row.nativeMessageId ?? nativeMessageId })
          }
          // Earlier builds recorded the native ID as an unread direct message.
          const alias = directByRemote.get(nativeMessageId ?? remoteId ?? '')
          if (alias && alias.body === item.text && !alias.consumedAt && !alias.removedAt) {
            this.state.put('delivery', alias.id, { ...alias, removedAt: at() })
          }
          continue
        }
        if (deliveryReference(item.text)) continue
        if (!remoteId) continue
        const existing = directByRemote.get(remoteId) ?? (nativeMessageId ? directByRemote.get(nativeMessageId) : undefined)
        if (existing) {
          this.recordConsumption(current, agent, { ...existing, nativeMessageId: existing.nativeMessageId ?? nativeMessageId })
          continue
        }
        const id = `${binding.id}:direct:${remoteId}`
        const direct: Delivery = { id, owner: binding.id, generation: binding.generation, assignmentId: binding.assignmentId,
          remoteId, nativeMessageId, message: { id: `direct:${remoteId}`, role: 'user', content: [{ type: 'text', text: item.text }], source: { kind: 'user' } },
          body: item.text, mode: 'steer', createdAt: at(), acceptedAt: at() }
        this.recordConsumption(current, agent, direct)
        if (snapshot?.status === 'running' && this.toolSignals.get(binding.id)?.signal.aborted && !this.cancelling.has(binding.id)) {
          this.state.afterCommit(() => { this.toolSignals.set(binding.id, new AbortController()) })
        }
        directByRemote.set(remoteId, direct)
        if (nativeMessageId) directByRemote.set(nativeMessageId, direct)
        continue
      }
      if (item.type !== 'assistant_message' && item.type !== 'tool_call') continue
      if (item.type === 'tool_call' || item.text.trim()) {
        replied = item.type === 'assistant_message'
        for (const id of currentTurn) turns.set(id, replied ? 'reply' : 'tool')
      }
      const content = item.type === 'assistant_message' ? [{ type: 'text' as const, text: item.text }]
        : [{ type: 'text' as const, text: JSON.stringify({ name: item.name, status: item.status, detail: item.detail }) }]
      const data = { message: { role: item.type === 'assistant_message' ? 'assistant' : 'tool', content } }
      const type = item.type === 'assistant_message' ? 'assistant/message' : 'tool/result'
      if (known) {
        const seq = Number(known.value), before = this.state.get('event', `${binding.id}:${seq}`)
        if (before && (before.type === 'assistant/message' || before.type === 'tool/result')) this.state.put('event', `${binding.id}:${seq}`, { ...before, data })
      } else {
        const event = agent.session.append(type, data); this.state.put('value', identity, { id: identity, value: String(event.seq) })
      }
    } })
    return { held, ambiguous, turns, epoch: pages.at(-1)?.epoch, snapshot }
  }
  private recordConsumption(binding: Binding, agent: ManagedAgent, row: Delivery): void {
    if (row.consumedAt || row.removedAt || row.generation !== binding.generation || row.assignmentId !== binding.assignmentId) return
    const consumedAt = at(), revision = row.promptRevision ?? binding.contextPromptRevision
    this.state.put('delivery', row.id, { ...row, acceptedAt: row.acceptedAt ?? consumedAt, consumedAt })
    for (const id of row.noticeIds ?? []) {
      const notice = this.state.get('notice', id)
      if (notice && !notice.consumedAt) this.state.put('notice', id, { ...notice, consumedAt })
    }
    this.state.afterCommit(() => {
      if (revision !== undefined) this.host.sessions.markPromptUsed(binding.id, revision)
      this.context.emit('agent/inbox/claimed', { agent, message: row.message })
    })
    agent.session.append('user/message', row.message)
  }
  /** Restore the persisted IDs before the Executor reconciles assignments; never use resumeAgent to clone them. */
  async recover(ensuredMainId?: string): Promise<void> {
    await this.ready
    for (const binding of this.state.list('binding').filter(binding => !binding.closed)) {
      if (binding.id !== ensuredMainId) await this.ensure(binding)
      this.replayConsumed(binding.id)
      if (binding.role === 'orchestrator') for (const row of this.state.list('delivery', binding.id)) if (row.queuedAt && !row.acceptedAt && !row.consumedAt && !row.removedAt) {
        this.state.put('delivery', row.id, { ...row, queueEpoch: this.binding(binding.id).resumeEpoch ?? 0 })
      }
    }
    this.callbacksReady = true
    this.jobs.startNotifications()
    this.jobs.reconcile()
    for (const binding of this.state.list('binding')) if (this.context.agents.has(binding.id)) void this.flushQueued(binding.id)
  }
  async refreshMainSession(): Promise<void> {
    const id = this.host.masterId
    // A save can arrive while the previous Profile is still being tried.
    await this.creating.get(id)?.catch(() => {})
    if (this.host.lifetime.aborted) return
    const binding = this.state.get('binding', id)
    if (binding && !binding.closed) await this.ensure(binding)
  }
  async reconcile(): Promise<void> {
    if (!this.callbacksReady || this.host.lifetime.aborted) return
    for (const binding of this.state.list('binding').filter(binding => !binding.closed && this.context.agents.has(binding.id))) {
      if (!binding.createdRemote || this.replacementProfile(binding) || this.state.get('replacement', binding.id) || this.state.list('retirement', binding.id).length
        || binding.role === 'orchestrator' && this.mainProblem) {
        await this.ensure(binding).catch(() => {})
        continue
      }
      const snapshot = (await this.client.fetchAgent(binding.agentId))?.agent
      if (snapshot) await this.queueUpdate(binding.id, snapshot, true)
      this.replayConsumed(binding.id)
      void this.flushQueued(binding.id)
      if (binding.parent) {
        const current = this.binding(binding.id)
        if (current.status === 'error' || current.status === 'closed') await this.failChild(binding.id, current.status)
        else this.settleChild(binding.id)
      }
    }
    for (const execution of this.state.list('execution').filter(row => row.kind === 'child' && row.notification === 'pending' && row.childAlias)) {
      const binding = this.binding(execution.childAlias!)
      if (!binding.closed) await this.childEnded(binding, execution).then(disposition => {
        this.state.put('execution', execution.id, { ...execution, notification: disposition })
      }).catch(() => {})
    }
  }
  private replayConsumed(owner: string): void {
    const binding = this.binding(owner), agent = this.context.agents.get(owner)
    if (!binding.ticketId || !(agent instanceof ManagedAgent)) return
    const ticket = this.host.store.tickets.get(binding.ticketId)
    if (!ticket || !liveTicket(ticket)) return
    for (const row of this.state.list('delivery', owner).filter(row => row.consumedAt)) {
      const needsRead = ticket.inputs.some(input => input.kind === 'trigger' && !input.readAt && this.host.sessions.promptedId(input.id) === row.message.id)
      if (needsRead) this.context.emit('session/event', agent.session, { type: 'user/message', data: row.message as SessionEvent['data'], seq: 0, time: Date.now() })
    }
  }
  private snapshot(binding: Binding): EffectiveSnapshot {
    const version = this.host.prompts.current(), settings = this.host.store.settings()
    const ticket = binding.ticketId ? this.host.store.tickets.get(binding.ticketId) : undefined
    const prompt = this.host.prompts.compose(version.config, binding.role, ticket ? this.host.ticketEnvironment(ticket) : undefined)
    // Keep current notices and unique receipts in context; superseded rows retain their original history in the ledger.
    const notices = this.state.list('notice', binding.id).filter(notice => !notice.supersededAt).sort((a, b) => a.order - b.order)
    return { role: binding.role, promptRevision: version.revision, skillsRevision: version.revision, policyRevision: policyVersion(settings),
      prompt: ticket ? prompt + '\n\n' + mandateInstructions(ticket.mandate) : prompt,
      policy: JSON.stringify({ policy: settings.policy, sourcePolicy: settingsPolicy(settings, this.host.sources), ticket: ticket ? { id: ticket.id, mandate: ticket.mandate, ended: ticket.ended } : undefined }),
      skills: [...this.host.prompts.skills(version.config)].map(([name, content]) => `## dsh-superagent-${name}\n${content}`).join('\n\n'),
      notices: notices.map(notice => ({ id: notice.id, text: notice.text, summary: notice.summary })) }
  }
  private async control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => {
      if (res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const auth = req.headers.authorization
    const hash = auth?.startsWith('Bearer ') ? digest(auth.slice(7)) : ''
    const owner = this.capabilities.get(hash)
    if (!owner) { reply(401, { error: 'Invalid session capability' }); return }
    if (req.url !== '/tools' && req.url !== '/tool') { reply(404, { error: 'Unknown application tool route' }); return }
    if (req.method !== 'POST') { reply(405, { error: 'Use POST for application tools' }); return }
    try {
      const binding = this.state.get('binding', owner)
      const signal = this.toolSignals.get(owner)?.signal
      if (!binding || binding.capabilityHash !== hash || !binding.createdRemote || !signal || this.closing || this.rotating.has(owner)) {
        reply(403, { error: 'Session is not active' })
        return
      }
      this.assertBinding(binding)
      if (req.url === '/tools') { reply(200, { tools: managedToolDefinitions(this, binding) }); return }
      signal.throwIfAborted()
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk)
        if (size > 2_000_000) { reply(413, { error: 'Request too large' }); return }
        chunks.push(Buffer.from(chunk))
      }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      if (typeof body.name !== 'string' || !body.name) { reply(400, { error: 'Tool name is required' }); return }
      this.assertBinding(binding)
      signal.throwIfAborted()
      const result = await this.callTool(binding, body.name, body.args, signal)
      const { imageContent, ...metadata } = object(result)
      const image = object(metadata.image)
      const structuredContent = imageContent ? metadata : result
      const content: unknown[] = [{ type: 'text', text: JSON.stringify(structuredContent) }]
      if (imageContent) content.push(imageContent)
      if (typeof image.id === 'string' && /^[a-f0-9-]+$/.test(image.id)) {
        const data = readFileSync(join(this.config.stateDir, 'attachments', image.id))
        content.push({ type: 'image', data: data.toString('base64'), mimeType: image.mediaType })
      }
      reply(200, { content, structuredContent })
    } catch (error) {
      // Tool diagnostics go to the capability holder without logging prompts, arguments, or credentials.
      if (req.url === '/tool') {
        const message = error instanceof Error ? error.message.slice(0, 1000) : 'Application tool call failed'
        reply(200, { content: [{ type: 'text', text: message }], isError: true })
      } else reply(403, { error: 'Application tool listing refused' })
    }
  }
  private async callTool(binding: Binding, name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    let listener: ReturnType<typeof addAbortListener> | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason))
    })
    try { return await Promise.race([cancelled, executeManagedTool(this, binding, name, args, signal)]) }
    finally { listener?.[Symbol.dispose]() }
  }
  children(parent: string): Binding[] {
    const direct = this.state.list('binding').filter(binding => binding.parent === parent)
    return direct.flatMap(child => [child, ...this.children(child.id)])
  }
  async createChild(parent: Binding, input: { prompt: string; name?: string; profileId?: string }, signal?: AbortSignal): Promise<unknown> {
    this.assertBinding(this.binding(parent.id))
    const profile = input.profileId ? await resolveRoleModel(this.context, input.profileId) : undefined
    signal?.throwIfAborted()
    this.assertBinding(parent)
    const id = `child-${randomUUID()}`, execution: OwnedExecution = { id: randomUUID(), owner: parent.id, kind: 'child', assignmentId: parent.assignmentId,
      generation: parent.generation, state: 'reserved', createdAt: at(), cwd: parent.cwd, label: input.name ?? 'Child task', childAlias: id }
    this.state.put('execution', execution.id, execution)
    try {
      const agent = await this.create(id, parent.cwd, 'dsh-superagent-worker', parent, profile)
      const child = this.binding(id)
      this.state.put('execution', execution.id, { ...execution, childAgentId: child.agentId })
      signal?.throwIfAborted()
      this.assertBinding(parent)
      await agent.followup({ id: `child-task:${execution.id}`, role: 'user', content: [{ type: 'text', text: input.prompt }], source: { kind: 'dsh-superagent', form: 'relay' } })
      return { agent_id: child.agentId, session_id: id, state: 'running' }
    } catch (error) {
      if (this.state.get('binding', id)) await this.stopChild(id)
      else this.state.put('execution', execution.id, { ...execution, state: 'failed', endedAt: at() })
      throw error
    }
  }
  private ownedChild(parent: Binding, id: string): Binding {
    const child = this.children(parent.id).find(child => child.id === id || child.agentId === id)
    if (!child) throw new Error('This conversation is not an owned descendant')
    return child
  }
  async messageChild(parent: Binding, id: string, text: string): Promise<void> {
    this.assertBinding(this.binding(parent.id)); const child = this.ownedChild(parent, id); this.assertBinding(child)
    await this.agent(child.id).steer({ id: `child-input:${randomUUID()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-superagent', form: 'relay' } })
  }
  async interruptChild(parent: Binding, id: string): Promise<void> { this.assertBinding(this.binding(parent.id)); await this.stopChild(this.ownedChild(parent, id).id) }
  private stopChild(id: string): Promise<void> {
    const existing = this.stoppingChildren.get(id); if (existing) return existing
    const pending = this.stopOwnedChild(id).finally(() => { this.stoppingChildren.delete(id) })
    this.stoppingChildren.set(id, pending); return pending
  }
  private async stopOwnedChild(id: string): Promise<void> {
    const binding = this.binding(id); if (binding.closed) return
    this.childrenClosing.add(id); this.invalidate(id)
    await Promise.all(this.state.list('binding').filter(child => child.parent === id && !child.closed).map(child => this.stopChild(child.id)))
    for (const job of this.jobs.list(id)) if (['reserved', 'running', 'stopping'].includes(job.state)) this.jobs.kill(job.id, id)
    const snapshot = (await this.client.fetchAgent(binding.agentId))?.agent
    if (snapshot) { await this.client.cancelAgent(binding.agentId); await this.client.archiveAgent(binding.agentId) }
    this.state.put('binding', id, { ...binding, closed: true, status: 'closed' })
    const agent = this.context.agents.get(id); if (agent) { this.context.agents.delete(id); this.context.emit('agent/disposed', { agent }) }
    for (const execution of this.state.list('execution').filter(execution => execution.childAlias === id && ['reserved', 'running'].includes(execution.state))) {
      this.state.put('execution', execution.id, { ...execution, state: 'killed', endedAt: at() })
    }
    this.childrenClosing.delete(id)
    this.wakeChildWaiters(id)
  }
  /** Human handoff retains shell jobs without callbacks or slots; trigger handback never calls this entry. */
  handoff(owner: string): void {
    const binding = this.binding(owner)
    this.state.atomic(() => {
      this.state.put('binding', owner, { ...binding, handedBack: true })
      for (const job of this.jobs.list(owner).filter(job => ['reserved', 'running', 'stopping'].includes(job.state))) {
        this.state.put('execution', job.id, { ...job, handedBack: true })
      }
    })
  }
  private async jobEnded(job: OwnedExecution): Promise<void | 'discarded' | 'queued'> {
    if (!this.callbacksReady || !this.context.orchestrator) throw new Error('The owning application has not recovered')
    if (this.closing || this.host.lifetime.aborted) throw new Error('The owning application is stopped')
    if (job.handedBack || this.state.get('execution', job.id)?.handedBack) return 'discarded'
    const binding = this.state.get('binding', job.owner)
    if (!binding) throw new Error('The owned job binding is unavailable')
    const ticket = binding.ticketId ? this.host.store.tickets.get(binding.ticketId) : undefined
    if (binding.closed || binding.handedBack || binding.generation !== job.generation || binding.assignmentId !== job.assignmentId
      || binding.ticketId && (!ticket || !liveTicket(ticket))) return 'discarded'
    this.assertBinding(binding)
    const agent = await this.ensure(binding)
    this.assertBinding(binding)
    if (this.binding(binding.id).handedBack) return 'discarded'
    await agent.followup({ id: `job-ended:${job.id}`, role: 'user', content: [{ type: 'text', text: JSON.stringify({ job_id: job.id, status: job.state, output: job.stdout, stderr: job.stderr }) }],
      source: { kind: 'tool-jobs', form: 'notice' } })
    const delivery = this.state.get('delivery', `${binding.id}:job-ended:${job.id}`)
    if (delivery?.removedAt) return 'discarded'
    if (!delivery?.acceptedAt && !delivery?.consumedAt) return 'queued'
  }
  private async childEnded(binding: Binding, execution: OwnedExecution): Promise<'delivered' | 'discarded'> {
    if (!binding.parent) return 'discarded'
    if (!this.context.orchestrator || this.closing || this.host.lifetime.aborted) throw new Error('The child owner is unavailable')
    const parent = this.binding(binding.parent)
    const ticket = parent.ticketId ? this.host.store.tickets.get(parent.ticketId) : undefined
    if (parent.closed || parent.handedBack || parent.assignmentId !== execution.assignmentId || parent.generation !== execution.generation
      || parent.ticketId && (!ticket || !liveTicket(ticket))) return 'discarded'
    this.assertBinding(parent)
    await this.syncTimeline(binding)
    const text = this.agent(binding.id).session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)?.data.message.content
      .filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
    this.assertBinding(parent)
    await this.agent(parent.id).steer({ id: `child-ended:${execution.id}`, role: 'user', content: [{ type: 'text', text: JSON.stringify({ child_agent: binding.agentId, state: execution.state, failure: execution.failure, result: text }) }], source: { kind: 'tool-jobs', form: 'notice' } })
    return 'delivered'
  }
  /** Close this application's gateway and transports after Runtime has reconciled and stopped its owned work. */
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.poll); this.jobs.dispose()
    for (const controller of this.toolSignals.values()) controller.abort()
    for (const unsubscribe of this.subscriptions) unsubscribe()
    await this.client.close()
    await Promise.allSettled(this.creating.values())
    this.server.closeAllConnections(); await new Promise<void>(resolve => { this.server.close(() => { resolve() }) })
    this.state.close()
  }
}
