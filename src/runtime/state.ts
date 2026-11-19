/** Durable Paseo bindings, delivery receipts, notices, and owned execution records. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import type { ModelSelection, SessionEvent, UserMessage } from './types.ts'
import type { RoleModel } from '../policy.ts'

export interface Binding {
  id: string; agentId: string; serverId?: string; workspaceId?: string; nativeSessionId?: string; cwd: string
  role: 'orchestrator' | 'worker'; ticketId?: string; parent?: string; assignmentId?: string; generation: number
  capabilityHash: string; file: string; provider: string; profile?: RoleModel; model: ModelSelection; createdRemote: boolean; status: string
  contextRevision?: string; contextPromptRevision?: number; previousAgentId?: string
  closed?: boolean; handedBack?: boolean
  resumeEpoch?: number; remoteUpdatedAt?: string
  identityError?: 'native-session-changed' | 'provider-changed'
}
export interface Delivery {
  id: string; owner: string; generation: number; assignmentId?: string; remoteId: string
  nativeMessageId?: string
  message: UserMessage; body: string; mode: 'queue' | 'steer'; createdAt: string
  acceptedAt?: string; consumedAt?: string; removedAt?: string; error?: string
  contextRevision?: string; promptRevision?: number; noticeIds?: string[]
  queuedAt?: string; queueEpoch?: number
  attempt?: { id: string; timelineEpoch: string; resumeEpoch: number; resumeAfterShutdown?: number; pending?: boolean }
  finishedAt?: string
}
export interface Notice {
  id: string; owner: string; mergeKey?: string; text: string; summary: string; order: number; createdAt: string
  consumedAt?: string; supersededAt?: string
}
interface SessionRetirement { id: string; owner: string; serverId?: string }
export interface OwnedExecution {
  id: string; owner: string; assignmentId?: string; generation: number; kind: 'shell' | 'child'; state: 'reserved' | 'running' | 'stopping' | 'completed' | 'failed' | 'killed'
  createdAt: string; endedAt?: string; handedBack?: boolean; cwd: string; label: string
  pid?: number; processIdentity?: string; childAgentId?: string; childAlias?: string; stdout?: string; stderr?: string
  exitCode?: number | null; signal?: string | null; nonce?: string; notification?: 'pending' | 'queued' | 'collected' | 'delivered' | 'discarded'
  failure?: 'provider-error' | 'provider-closed'; cleanupPending?: boolean
}
interface Records { binding: Binding; replacement: Binding; retirement: SessionRetirement; delivery: Delivery; notice: Notice; execution: OwnedExecution;
  event: SessionEvent & { owner: string }; value: { id: string; value: string } }

/** One SQLite ledger under the application state lock; writes commit before any external execution begins. */
export class RuntimeState {
  readonly db: DatabaseSync
  private transaction = false
  private readonly committed: (() => void)[] = []
  constructor(path: string) {
    this.db = new DatabaseSync(path); chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runtime_record(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS runtime_record_owner ON runtime_record(kind,owner);`)
  }
  get<K extends keyof Records>(kind: K, id: string): Records[K] | undefined {
    const row = this.db.prepare('SELECT value FROM runtime_record WHERE kind=? AND id=?').get(kind, id)
    return row ? JSON.parse(String(row.value)) as Records[K] : undefined
  }
  list<K extends keyof Records>(kind: K, owner?: string): Records[K][] {
    const rows = owner === undefined ? this.db.prepare('SELECT value FROM runtime_record WHERE kind=? ORDER BY rowid').all(kind)
      : this.db.prepare('SELECT value FROM runtime_record WHERE kind=? AND owner=? ORDER BY rowid').all(kind, owner)
    return rows.map(row => JSON.parse(String(row.value)) as Records[K])
  }
  put<K extends keyof Records>(kind: K, id: string, value: Records[K], owner = 'owner' in value ? String(value.owner) : id): void {
    this.db.prepare('INSERT INTO runtime_record(kind,id,owner,value) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,value=excluded.value')
      .run(kind, id, owner, JSON.stringify(value))
  }
  delete(kind: keyof Records, id: string): void {
    this.db.prepare('DELETE FROM runtime_record WHERE kind=? AND id=?').run(kind, id)
  }
  atomic<T>(run: () => T): T {
    if (this.transaction) return run()
    this.db.exec('BEGIN IMMEDIATE'); this.transaction = true
    try {
      const result = run(); this.db.exec('COMMIT'); this.transaction = false
      for (const callback of this.committed.splice(0)) callback()
      return result
    } catch (error) { if (this.transaction) this.db.exec('ROLLBACK'); this.committed.length = 0; throw error } finally { this.transaction = false }
  }
  afterCommit(run: () => void): void { if (this.transaction) this.committed.push(run); else run() }
  close(): void { this.db.close() }
}
