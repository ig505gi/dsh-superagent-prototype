/** Detached shell supervisor; its durable status and output survive an application process crash. */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RunnerInput { nonce: string; command: string; cwd: string; env: Record<string, string> }
export interface RunnerStatus { nonce: string; pid: number; processIdentity: string; state: 'running' | 'completed' | 'failed' | 'killed'; exitCode?: number | null; signal?: string | null }
/** Process birth identity, used with the owned nonce before ever signalling a recovered PID. */
export function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const data = readFileSync(`/proc/${pid}/stat`, 'utf8'); return data.slice(data.lastIndexOf(')') + 2).split(' ')[19]
    }
    const birth = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }).trim()
    return birth || undefined
  } catch { return undefined }
}

/** Execute one registered job and atomically retain its final status without deleting evidence. */
export async function runJob(file: string): Promise<void> {
  const input = JSON.parse(readFileSync(file, 'utf8')) as RunnerInput
  const directory = dirname(file), statusFile = join(directory, 'status.json')
  const identity = processIdentity(process.pid)
  if (!identity) throw new Error('Cannot establish owned process identity')
  const status: RunnerStatus = { nonce: input.nonce, pid: process.pid, processIdentity: identity, state: 'running' }
  const save = () => { const temporary = `${statusFile}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 }); renameSync(temporary, statusFile) }
  const stdout = openSync(join(directory, 'stdout'), 'a', 0o600), stderr = openSync(join(directory, 'stderr'), 'a', 0o600)
  const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', input.command] : ['-c', input.command], {
    cwd: input.cwd, env: input.env, stdio: ['ignore', stdout, stderr],
  })
  let ending = false
  const stop = () => { ending = true; child.kill('SIGTERM') }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  save()
  await new Promise<void>(resolve => {
    child.once('error', () => { status.state = 'failed'; status.exitCode = -1; save(); resolve() })
    child.once('exit', (code, signal) => { status.state = ending || signal ? 'killed' : code === 0 ? 'completed' : 'failed'; status.exitCode = code; status.signal = signal; save(); resolve() })
  })
  closeSync(stdout); closeSync(stderr)
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2]
  if (!file) throw new Error('An owned job specification is required')
  await runJob(file)
}
