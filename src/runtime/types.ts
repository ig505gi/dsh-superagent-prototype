/** Application session, tool, and process contracts used by the Paseo runtime. */
import { randomUUID } from 'node:crypto'
import type { RoleModel } from '../policy.ts'
export type SessionId = string
export const SessionId = (value: string): SessionId => value
export type MessageId = string
export const MessageId = (value: string): MessageId => value
export const SessionSeq = (value: number): number => value
export const SENSITIVE_ENV_PATTERN = /(?:KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL)/i
export type ModelSelection = Pick<RoleModel, 'provider' | 'model' | 'modeId' | 'thinkingOptionId' | 'featureValues'>
export interface MessageSource { kind: string; form?: string; summary?: string; mergeKey?: string; rpcId?: string; plugin?: string }
export type ContentBlock = { type: 'text'; text: string } | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }
export interface UserMessage { id: string; role: 'user'; content: ContentBlock[]; source: MessageSource }
export const freezeMessage = <T extends UserMessage>(message: T): T => Object.freeze(message)
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface ImageAttachmentRef { id: string; mediaType: ImageMediaType; name?: string; path?: string }
export interface AssistantMessage { role: 'assistant'; content: ContentBlock[]; source: MessageSource & { provider?: string; model?: string } }
export const createUserMessage = (value: Omit<UserMessage, 'id' | 'role'> & { id?: string }): UserMessage => ({ ...value, id: value.id ?? randomUUID(), role: 'user' })
export const createAssistantMessage = (value: { content: ContentBlock[]; source: { provider: string; model: string } }): AssistantMessage => ({ ...value, role: 'assistant', source: { kind: 'model', ...value.source } })
export type SessionEventType = 'user/message' | 'assistant/message' | 'tool/result' | 'model/selection' | 'request/header' | 'turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'llm/retry' | 'llm/retry-started'
type EventData<K extends SessionEventType> = K extends 'user/message' ? UserMessage : K extends 'assistant/message' | 'tool/result'
  ? { message: { role: string; content: ContentBlock[]; source?: MessageSource }; [name: string]: unknown } : Record<string, unknown>
export type SessionEvent<T extends SessionEventType = SessionEventType> = { [K in T]: { type: K; seq: number; time: number; surfaceOp?: 'append'; data: EventData<K> } }[T]
export interface Session {
  id: string
  header: { agentPreset?: string; parentSession?: string }
  snapshotEvents(): SessionEvent[]
  requestHeader(): { config: ModelSelection } | undefined
  append(type: SessionEventType, data: unknown): SessionEvent
}
export interface RegisteredTool {
  name: string; description?: string; parameters?: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render(args: unknown, value: unknown): unknown[] }
  execute(args: unknown, execution: { signal: AbortSignal }): Promise<unknown>
}
export interface ToolExecution { name: string; arguments: unknown }
export interface ToolRegistry {
  register(tool: RegisteredTool): () => void
  get(name: string, scope?: unknown): RegisteredTool | undefined
  restrict(options: { allow: string[] }): () => void
  guard(check: (execution: ToolExecution) => string | undefined | Promise<string | undefined>): () => void
}
export interface SkillDefinition { name: string; description: string; content: string; source: string; resourceBase?: { kind: 'directory'; path: string } }
export interface PromptSection { name: string; order: number; interpolate?: boolean; complete?: boolean; text(context: { signal?: AbortSignal }): string }
export interface SubprocessOutputReader { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
export interface SubprocessRuntime {
  spawn(spec: { argv: readonly string[]; cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal;
    stdin?: unknown; stdout?: unknown; stderr?: unknown; [name: string]: unknown }): {
      done: Promise<{ exitCode: number | null; signal: string | null }>
      collected: { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader }
    }
}
export interface ModelCatalog {
  readonly profiles: readonly (RoleModel & { available: boolean })[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}
export interface Agent {
  id: string
  ctx: import('./context.ts').Context
  session: Session
  options: Partial<ModelSelection>
  status: string
  inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[]; remove(id: string): boolean }
  followup(message: UserMessage): void | Promise<void>
  steer(message: UserMessage): void | Promise<void>
  inject(message: UserMessage): void | Promise<void>
  cancel(cause?: unknown, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}
export interface SessionController {
  resolveAgent(id: string): Promise<{ agent: Agent } | { error: { code: string; message?: string } }>
  create(input: { sessionId: string; workspaceId: string; agentPreset: string }): Promise<void>
  rename(input: { sessionId: string; title: string }): Promise<void>
  inspect(id: string): Promise<{ events: SessionEvent[] }>
  modelCatalog(): Promise<ModelCatalog>
}
export interface SessionPersistence {
  flush(): Promise<void>
  open(id: string, mode: 'read'): Promise<{ read(offset: number, limit: number): Promise<{ events: SessionEvent[] }>; [Symbol.asyncDispose](): Promise<void> }>
}
