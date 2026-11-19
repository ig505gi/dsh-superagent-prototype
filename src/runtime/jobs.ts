/** Persistent controlled shell jobs and completion events consumed by the existing worker slot manager. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandEnvironment } from './process.ts'
import { processIdentity, type RunnerInput, type RunnerStatus } from './job-runner.ts'
import type { Binding, OwnedExecution, RuntimeState } from './state.ts'

/** Registers before launch, checks process identity on recovery, and keeps jobs attached to their original assignment. */
export class ShellJobs {
  private readonly listeners = new Set<{ owner: string; listener(event: { type: string }): void }>()
  private readonly waiters = new Map<string, Set<(job: OwnedExecution) => void>>()
  private readonly notifying = new Set<string>()
  private notificationsReady = false
  private readonly timer: ReturnType<typeof setInterval>
  readonly events = { subscribe: (filter: { owner: string }, listener: (event: { type: string }) => void): (() => void) => {
    const entry = { owner: filter.owner, listener }; this.listeners.add(entry); return () => { this.listeners.delete(entry) }
  } }
  constructor(private readonly state: RuntimeState, private readonly root: string,
    private readonly notify: (job: OwnedExecution) => Promise<void | 'discarded' | 'queued'>) {
    this.timer = setInterval(() => { this.reconcile() }, 500); this.timer.unref(); this.reconcile()
  }
  /** Recovered status may be inspected immediately; callbacks start only after their owning host and bindings are restored. */
  startNotifications(): void { this.notificationsReady = true; this.reconcile() }
  list(owner: string): (OwnedExecution & { status: string; label: string })[] {
    return this.state.list('execution', owner).filter(job => job.kind === 'shell').map(job => ({ ...job, status: job.state }))
  }
  private directory(id: string): string { return join(this.root, 'jobs', id) }
  private status(id: string): RunnerStatus | undefined {
    try { return JSON.parse(readFileSync(join(this.directory(id), 'status.json'), 'utf8')) as RunnerStatus } catch { return undefined }
  }
  private output(id: string, name: 'stdout' | 'stderr'): string {
    try { return readFileSync(join(this.directory(id), name), 'utf8').slice(-64_000) } catch { return '' }
  }
  async start(binding: Binding, command: string, env: Record<string, string | undefined>, timeoutMs = 5000, background = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted()
    const id = randomUUID(), nonce = randomUUID(), directory = this.directory(id)
    const job: OwnedExecution = { id, owner: binding.id, assignmentId: binding.assignmentId, generation: binding.generation, kind: 'shell', state: 'reserved',
      createdAt: new Date().toISOString(), cwd: binding.cwd, label: command.split('\n')[0]!.slice(0, 160), nonce }
    this.state.put('execution', id, job)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const input: RunnerInput = { nonce, command, cwd: binding.cwd, env: commandEnvironment(env) }
    const file = join(directory, 'input.json'); writeFileSync(file, JSON.stringify(input), { mode: 0o600, flag: 'wx' })
    const builtRunner = fileURLToPath(new URL('./job-runner.js', import.meta.url))
    const runner = existsSync(builtRunner) ? builtRunner : fileURLToPath(new URL('./job-runner.ts', import.meta.url))
    const child = spawn(process.execPath, [runner, file], { cwd: binding.cwd, detached: true, stdio: 'ignore', env: commandEnvironment() })
    child.once('error', () => { const failed = { ...job, state: 'failed' as const, endedAt: new Date().toISOString() }; this.state.put('execution', id, failed); this.settled(failed) })
    child.unref()
    job.pid = child.pid; job.processIdentity = child.pid ? processIdentity(child.pid) : undefined; job.state = 'running'; this.state.put('execution', id, job)
    const view = background ? job : await this.wait(id, Math.min(Math.max(timeoutMs, 0), 5000), binding.id, signal)
    return { job_id: id, status: view.state, output: this.output(id, 'stdout'), stderr: this.output(id, 'stderr'), exit_code: view.exitCode ?? null }
  }
  private settled(job: OwnedExecution): void {
    const waiters = this.waiters.get(job.id), collected = !!waiters?.size
    const recorded: OwnedExecution = { ...job, notification: collected || job.handedBack ? 'collected' : 'pending' }
    this.state.put('execution', job.id, recorded)
    for (const wake of waiters ?? []) wake(job)
    for (const entry of this.listeners) if (entry.owner === job.owner) entry.listener({ type: 'settled' })
    if (recorded.notification === 'pending') this.deliverNotification(recorded)
  }
  private deliverNotification(job: OwnedExecution): void {
    if (!this.notificationsReady || this.notifying.has(job.id)) return
    this.notifying.add(job.id)
    void this.notify(job).then(disposition => {
      const current = this.state.get('execution', job.id)
      if (current && !(disposition === 'queued' && current.notification === 'delivered')) this.state.put('execution', job.id, { ...current, notification: disposition ?? 'delivered' })
    }).catch(() => { /* The next reconciliation retries the same durable callback ID. */ }).finally(() => { this.notifying.delete(job.id) })
  }
  reconcile(): void {
    for (const job of this.state.list('execution').filter(item => item.kind === 'shell' && ['reserved', 'running', 'stopping'].includes(item.state))) {
      const status = this.status(job.id)
      if (status && status.nonce === job.nonce && (status.state !== 'running' || processIdentity(status.pid) === status.processIdentity)) {
        const changed = status.state !== 'running'
        const updated: OwnedExecution = { ...job, ...status, state: !changed && job.state === 'stopping' ? 'stopping' : status.state, stdout: this.output(job.id, 'stdout'), stderr: this.output(job.id, 'stderr'),
          ...(changed ? { endedAt: new Date().toISOString() } : {}) }
        this.state.put('execution', job.id, updated); if (changed) this.settled(updated)
      } else if (job.pid && processIdentity(job.pid) !== job.processIdentity || Date.now() - Date.parse(job.createdAt) > 10_000 && !job.pid) {
        const failed: OwnedExecution = { ...job, state: job.state === 'stopping' ? 'killed' : 'failed', endedAt: new Date().toISOString(), stderr: 'The owned process is no longer present; execution was not repeated' }
        this.state.put('execution', job.id, failed); this.settled(failed)
      }
    }
    for (const job of this.state.list('execution').filter(item => item.kind === 'shell' && item.notification === 'pending')) this.deliverNotification(job)
  }
  async wait(id: string, timeoutMs: number, owner: string, signal?: AbortSignal): Promise<OwnedExecution & { status: string }> {
    const job = this.state.get('execution', id)
    if (!job || job.owner !== owner || job.kind !== 'shell') throw new Error('Job is not owned by this session')
    if (!['reserved', 'running', 'stopping'].includes(job.state)) return { ...job, status: job.state }
    return new Promise((resolve, reject) => {
      let waiters = this.waiters.get(id); if (!waiters) this.waiters.set(id, waiters = new Set())
      const done = (value: OwnedExecution) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); waiters.delete(done); resolve({ ...value, status: value.state }) }
      const abort = () => { clearTimeout(timer); waiters.delete(done); reject(new Error('Job wait cancelled')) }
      const timer = setTimeout(() => { done(this.state.get('execution', id)!) }, timeoutMs)
      waiters.add(done); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    })
  }
  read(id: string, owner: string): Record<string, unknown> {
    const job = this.state.get('execution', id)
    if (!job || job.owner !== owner || job.kind !== 'shell') throw new Error('Job is not owned by this session')
    return { job_id: id, status: job.state, output: this.output(id, 'stdout'), stderr: this.output(id, 'stderr'), exit_code: job.exitCode ?? null }
  }
  kill(id: string, owner: string, _reason?: string): void {
    const job = this.state.get('execution', id), status = this.status(id)
    if (!job || job.owner !== owner || job.kind !== 'shell') throw new Error('Job is not owned by this session')
    if (!['reserved', 'running', 'stopping'].includes(job.state)) return
    const pid = status && status.nonce === job.nonce ? status.pid : job.pid
    const identity = status && status.nonce === job.nonce ? status.processIdentity : job.processIdentity
    if (!pid || !identity || processIdentity(pid) !== identity) { this.reconcile(); return }
    this.state.put('execution', id, { ...job, state: 'stopping' })
    try { process.kill(-pid, 'SIGTERM') } catch { this.reconcile() }
    const force = setTimeout(() => { if (processIdentity(pid) === identity) { try { process.kill(-pid, 'SIGKILL') } catch { /* Already exited. */ } } }, 2000)
    force.unref()
  }
  dispose(): void { clearInterval(this.timer) }
}
