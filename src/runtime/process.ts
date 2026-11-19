/** Local command transport for setup and controlled shell execution, never for running a model. */
import { spawn } from 'node:child_process'
import type { SubprocessRuntime } from './types.ts'
import { processIdentity } from './job-runner.ts'

/** Strip application credentials from commands while retaining CLI file-based authentication and isolated git settings. */
export function commandEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const merged = { ...process.env, ...overrides }
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined
    && !/(?:KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL)/i.test(entry[0]) && !entry[0].startsWith('SUPERAGENT_CONTROL_')))
}
/** Bounded output and abortable process groups used by the existing setup/worktree checks. */
export class LocalProcesses implements SubprocessRuntime {
  spawn(spec: Parameters<SubprocessRuntime['spawn']>[0]): ReturnType<SubprocessRuntime['spawn']> {
    spec.signal?.throwIfAborted()
    const [program, ...args] = spec.argv
    if (!program) throw new Error('A command executable is required')
    const child = spawn(program, args, { cwd: spec.cwd, env: commandEnvironment(spec.env), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', forced: ReturnType<typeof setTimeout> | undefined
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-1_048_576) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65_536) })
    let pid: number | undefined, identity: string | undefined
    const running = () => pid !== undefined && pid > 0 && child.pid === pid && child.exitCode === null && child.signalCode === null
      && identity !== undefined && processIdentity(pid) === identity
    const kill = (signal: NodeJS.Signals) => {
      if (!running()) return
      try { if (process.platform !== 'win32') process.kill(-pid!, signal); else child.kill(signal) } catch { /* Already exited. */ }
    }
    const abort = () => {
      if (!running()) return
      kill('SIGTERM'); forced = setTimeout(() => { kill('SIGKILL') }, 2000); forced.unref()
    }
    const started = () => {
      pid = child.pid; identity = pid && pid > 0 ? processIdentity(pid) : undefined
      if (spec.signal?.aborted) abort(); else spec.signal?.addEventListener('abort', abort, { once: true })
    }
    const cleanup = () => { clearTimeout(forced); child.off('spawn', started); spec.signal?.removeEventListener('abort', abort) }
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', () => { cleanup(); reject(new Error('The configured command could not start')) })
      child.once('exit', (exitCode, signal) => { cleanup(); resolve({ exitCode, signal }) })
    })
    child.once('spawn', started)
    const reader = (text: () => string) => ({ readFrom: (offset: number) => ({ text: text().slice(offset), nextOffset: text().length, lossy: false }) })
    return { done, collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) } }
  }
}
