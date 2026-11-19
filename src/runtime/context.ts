/** In-process services and lifecycle events shared by the standalone application. */
import { format } from 'node:util'
import type { SourceHost } from '../sources/host.ts'
import type { Agent, ModelCatalog, PromptSection, Session, SessionController, SessionEvent, SessionPersistence,
  SkillDefinition, SubprocessRuntime, ToolRegistry, UserMessage } from './types.ts'

interface Events {
  'agent/status': (value: { agent: Agent; status: string }) => void
  'agent/created': (value: { agent: Agent }) => unknown
  'agent/disposed': (value: { agent: Agent }) => void
  'agent/error': (value: { agent: Agent; error: unknown; turn?: number; step?: number }) => void
  'agent/inbox/claimed': (value: { agent: Agent; message: UserMessage; turn?: number }) => void
  'session/event': (session: Session, event: SessionEvent) => void
  'agent-preset/selected': (sessionId: string, preset: string) => void
}
export interface Volatile<T> { get(): T }
type Listener = (...args: unknown[]) => unknown
export interface PromptRegistry {
  section(value: PromptSection): () => void
  assemble(context?: { signal?: AbortSignal }): Promise<{ sections: PromptSection[]; variables: Record<string, string> }>
}
export interface AttachmentService {
  imageLimits: { maxImageBytes: number; maxMessageImageBytes: number }
  saveImage(input: { data: Uint8Array; mediaType: import('./types.ts').ImageMediaType; name: string }): Promise<import('./types.ts').ImageAttachmentRef>
}
/** Explicit service container and event lifetime for this application, independent of an agent host framework. */
export class Context {
  readonly agents = new Map<string, Agent>()
  declare orchestrator: SourceHost
  declare runtime: import('./paseo.ts').PaseoRuntime | undefined
  declare sessionController: SessionController
  declare sessionPersistence: SessionPersistence
  declare subprocess: SubprocessRuntime
  declare tools: ToolRegistry
  declare systemPrompt: PromptRegistry
  declare skills: { register(skill: SkillDefinition): () => void }
  declare workspaceRegistry: { create(cwd: string): Promise<{ id: string }> }
  readonly permissionPresets = { set: (_session: Session, _preset: string): void => {} }
  declare llm: { resolveModelInfo(provider: string, model: string, signal: AbortSignal): Promise<{ inputModalities?: string[] }> }
  declare attachments: AttachmentService
  declare webServer: { host: string; port: number; register(route: { kind?: string; path?: string; [name: string]: unknown; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }): () => void }
  readonly logger = { warn: (message: string, ...values: unknown[]): void => { console.warn(format(message, ...values)) },
    error: (message: string, ...values: unknown[]): void => { console.error(format(message, ...values)) },
    info: (message: string, ...values: unknown[]): void => { console.info(format(message, ...values)) } }
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly releases: (() => void | Promise<void>)[] = []
  private readonly provided = new Set<string>()
  private readonly injections = new Set<{ names: string[]; run(): void }>()
  /** Kept local so test fixtures and source registration can supply these explicit services without a global daemon plugin. */
  readonly reflect = { provide: (name: string, service: unknown): void => {
    Object.defineProperty(this, name, { value: service, writable: true, configurable: true, enumerable: true })
    this.provided.add(name)
    for (const item of this.injections) if (item.names.includes(name)) item.run()
  } }
  readonly fiber = { dispose: (): Promise<void> => this.dispose() }
  get(name: 'attachments'): AttachmentService | undefined
  get(name: 'llm'): Context['llm'] | undefined
  get(name: string): unknown
  get(name: string): unknown { return (this as unknown as Record<string, unknown>)[name] }
  on<K extends keyof Events>(name: K, handler: Events[K], _options?: { prepend?: boolean }): () => void
  on<A extends unknown[]>(name: string, handler: (...args: A) => unknown, _options?: { prepend?: boolean }): () => void
  on(name: string, handler: unknown, _options?: { prepend?: boolean }): () => void {
    if (typeof handler !== 'function') throw new TypeError('An event listener must be a function')
    let list = this.listeners.get(name)
    if (!list) this.listeners.set(name, list = new Set())
    list.add(handler as Listener)
    const release = () => { list.delete(handler as Listener) }
    this.releases.push(release)
    return release
  }
  emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
  emit(name: string, ...args: unknown[]): void
  emit(name: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(name) ?? []) {
      const result = listener(...args)
      if (result instanceof Promise) void result.catch(() => { this.logger.warn('An application event handler failed') })
    }
  }
  async parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void> {
    await Promise.all([...(this.listeners.get(name) ?? [])].map(listener => listener(...args)))
  }
  effect(factory: () => void | (() => void | Promise<void>), _label?: string): void {
    const release = factory(); if (release) this.releases.push(release)
  }
  inject(names: string[], callback: (scope: Context) => unknown): Promise<void> & { dispose(): Promise<void> } {
    let scope: Context | undefined
    const item = { names, run: (): void => {
      if (!names.every(name => this.get(name) !== undefined)) return
      if (scope) void scope.dispose()
      scope = Object.create(this) as Context
      Object.defineProperty(scope, 'releases', { value: [] })
      callback(scope)
    } }
    this.injections.add(item); item.run()
    const dispose = async () => { this.injections.delete(item); await scope?.dispose() }
    this.releases.push(dispose)
    return Object.assign(Promise.resolve(), { dispose })
  }
  async dispose(): Promise<void> { for (const release of this.releases.splice(0).reverse()) await release() }
}

/** Render registered sections for callers that need a text projection, without writing full prompts to logs. */
export function renderPrompt(value: { sections: { text: string | PromptSection['text']; [name: string]: unknown }[]; [name: string]: unknown }, context: { signal?: AbortSignal } = {}): string {
  return value.sections.map(section => typeof section.text === 'function' ? section.text(context) : section.text).join('\n\n')
}
export type { ModelCatalog }
