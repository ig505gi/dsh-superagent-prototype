/** Move test fixtures out of the way while keeping them recoverable. */
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, renameSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
export function trashSync(path: string, _options?: { recursive?: boolean; force?: boolean }): void {
  const exact = resolve(path)
  if (exact === '/' || exact === homedir() || exact === process.cwd()) throw new Error('Unsafe test cleanup target')
  if (!lstatSync(exact, { throwIfNoEntry: false })) return

  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/trash', [exact])
    return
  }
  if (process.platform === 'linux' && spawnSync('gio', ['trash', '--', exact], { stdio: 'ignore' }).status === 0) return

  // Fixtures live under tmpdir(). Keep the recovery directory outside the fixture tree.
  const recovery = mkdtempSync(join(tmpdir(), 'superagent-test-trash-'))
  try {
    renameSync(exact, join(recovery, basename(exact)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
