/** Test cleanup uses macOS Trash; other platforms retain fixtures instead of permanently deleting them. */
import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
export function trashSync(path: string, _options?: { recursive?: boolean; force?: boolean }): void {
  const exact = resolve(path)
  if (exact === '/' || exact === homedir() || exact === process.cwd()) throw new Error('Unsafe test cleanup target')
  try { lstatSync(exact) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (process.platform === 'darwin') execFileSync('/usr/bin/trash', [exact])
}
