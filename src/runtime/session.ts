/** Application projections for a durable Paseo conversation and its scoped tools. */
import { Context, type PromptRegistry } from './context.ts'
import type { Agent, ModelSelection, PromptSection, RegisteredTool, Session, SessionEvent, SessionEventType, SkillDefinition, ToolExecution, ToolRegistry, UserMessage } from './types.ts'
import type { RuntimeState } from './state.ts'

/** Scoped tools retain the existing role restrictions and run every registered guard before execution. */
export class ScopedTools implements ToolRegistry {
  readonly local = new Map<string, RegisteredTool>()
  private readonly restrictions = new Set<ReadonlySet<string>>()
  private readonly guards = new Set<(execution: ToolExecution) => string | undefined | Promise<string | undefined>>()
  register(tool: RegisteredTool): () => void { this.local.set(tool.name, tool); return () => { if (this.local.get(tool.name) === tool) this.local.delete(tool.name) } }
  get(name: string): RegisteredTool | undefined { return this.local.get(name) }
  allows(name: string): boolean { return [...this.restrictions].every(allow => allow.has(name)) }
  restrict({ allow }: { allow: string[] }): () => void { const set = new Set(allow); this.restrictions.add(set); return () => { this.restrictions.delete(set) } }
  guard(check: (execution: ToolExecution) => string | undefined | Promise<string | undefined>): () => void { this.guards.add(check); return () => { this.guards.delete(check) } }
  async authorize(name: string, input: unknown): Promise<string | undefined> {
    if (!this.allows(name)) return 'Tool is outside this session role'
    for (const guard of this.guards) { const refusal = await guard({ name, arguments: input }); if (refusal) return refusal }
    return undefined
  }
}
/** Application prompt and skill registrations attached to a session. */
export class ScopedPrompts implements PromptRegistry {
  readonly sections = new Set<PromptSection>()
  readonly skills = new Map<string, SkillDefinition>()
  section(value: PromptSection): () => void { this.sections.add(value); return () => { this.sections.delete(value) } }
  async assemble(): Promise<{ sections: PromptSection[]; variables: Record<string, string> }> { return { sections: [...this.sections].sort((a, b) => a.order - b.order), variables: {} } }
}
/** Persistent application transcript and model selection, keyed by the application's stable session alias. */
export class ApplicationSession implements Session {
  readonly header: Session['header']
  constructor(readonly id: string, private readonly state: RuntimeState, header: Session['header'], private readonly emit: (event: SessionEvent) => void) { this.header = header }
  snapshotEvents(): SessionEvent[] { return this.state.list('event', this.id).map(({ owner: _owner, ...event }) => event) }
  requestHeader(): { config: ModelSelection } | undefined {
    const selection = this.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)
    return selection ? { config: selection.data as unknown as ModelSelection } : undefined
  }
  append(type: SessionEventType, data: unknown): SessionEvent {
    const event = { type, data, seq: this.snapshotEvents().length, time: Date.now() } as SessionEvent
    this.state.put('event', `${this.id}:${event.seq}`, { ...event, owner: this.id }); this.state.afterCommit(() => { this.emit(event) }); return event
  }
}
export interface AgentTransport {
  enqueue(message: UserMessage, mode: 'queue' | 'steer'): Promise<void>
  notice(message: UserMessage): Promise<void>
  cancel(keepInbox: boolean): Promise<void>
  remove(id: string): boolean
  pending(mode: 'queue' | 'steer'): UserMessage[]
}
/** Thin local handle for one visible Paseo agent; model work always goes through the daemon transport. */
export class ManagedAgent implements Agent {
  readonly ctx = new Context()
  readonly tools = new ScopedTools()
  readonly prompts = new ScopedPrompts()
  readonly session: ApplicationSession
  readonly inbox: Agent['inbox']
  private currentStatus = 'idle'
  private readonly idle = new Set<() => void>()
  constructor(readonly id: string, private readonly host: Context, state: RuntimeState, header: Session['header'], readonly options: Partial<ModelSelection>, private readonly transport: AgentTransport) {
    this.session = new ApplicationSession(id, state, header, event => host.emit('session/event', this.session, event))
    this.ctx.reflect.provide('tools', this.tools); this.ctx.reflect.provide('systemPrompt', this.prompts)
    this.ctx.reflect.provide('skills', { register: (skill: SkillDefinition) => { this.prompts.skills.set(skill.name, skill); return () => { this.prompts.skills.delete(skill.name) } } })
    this.ctx.reflect.provide('llm', host.llm); this.ctx.reflect.provide('attachments', host.attachments)
    const handle = this
    this.inbox = { get nextTurn() { return transport.pending('queue') }, get nextStep() { return transport.pending('steer') }, remove: id => handle.transport.remove(id) }
  }
  get status(): string { return this.currentStatus }
  set status(status: string) {
    if (this.currentStatus === status) return
    this.currentStatus = status
    if (status === 'idle' || status === 'error' || status === 'closed') { for (const resolve of this.idle) resolve(); this.idle.clear() }
    this.host.emit('agent/status', { agent: this, status })
  }
  followup(message: UserMessage): Promise<void> { return this.transport.enqueue(message, 'queue') }
  steer(message: UserMessage): Promise<void> { return this.transport.enqueue(message, 'steer') }
  inject(message: UserMessage): Promise<void> { return this.transport.notice(message) }
  cancel(_cause?: unknown, options?: { keepInbox?: boolean }): void {
    void this.transport.cancel(!!options?.keepInbox).catch(() => { this.host.logger.warn('An owned Paseo agent could not be cancelled') })
  }
  whenIdle(): Promise<void> { return ['idle', 'error', 'closed'].includes(this.status) ? Promise.resolve() : new Promise(resolve => { this.idle.add(resolve) }) }
}
