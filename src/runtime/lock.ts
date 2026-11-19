/** One exclusive lease covers every application database and settings file from the first initialization step. */
import { mkdirSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'
export interface StateLease { stateDir: string; release(): void }
export function acquireStateLock(stateDir: string, compromised: (error: Error) => void): StateLease {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const unlock = lockSync(stateDir, { stale: 30_000, onCompromised: compromised })
  let released = false
  return { stateDir, release: () => { if (!released) { released = true; unlock() } } }
}
