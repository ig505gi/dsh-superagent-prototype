/** Recoverable disposal of application-owned temporary files; Linux keeps retired files in an explicit state directory. */
import { execFile } from 'node:child_process'
import { lstat, mkdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
const exec = promisify(execFile)
export async function retireOwned(path: string, retainedDirectory: string): Promise<void> {
  try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (process.platform === 'darwin') { await exec('/usr/bin/trash', [path]); return }
  await mkdir(retainedDirectory, { recursive: true, mode: 0o700 })
  await rename(path, join(retainedDirectory, `${basename(path)}-${randomUUID()}`))
}
