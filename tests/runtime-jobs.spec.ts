/** Real detached jobs preserve their owned identity across application-ledger reopen without rerunning commands. */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { RuntimeState, type Binding } from '../src/runtime/state.ts'
import { ShellJobs } from '../src/runtime/jobs.ts'
import { trashSync } from './fixtures/trash.ts'
it('reconstructs a running job, refuses foreign reads, kills its original process and keeps completion evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owned-shell-recovery-'))
  let state = new RuntimeState(join(root, 'ledger.sqlite')), callbacks = 0
  let jobs = new ShellJobs(state, root, async () => { callbacks++ })
  const binding = { id: 'worker-owned', assignmentId: 'assignment-1', generation: 7, cwd: root } as Binding
  try {
    const created = await jobs.start(binding, 'sleep 30', {}, 0, true), id = String(created.job_id)
    await vi.waitFor(() => { jobs.reconcile(); expect(state.get('execution', id)?.processIdentity).toBeTruthy() })
    const before = state.get('execution', id)!
    jobs.dispose(); state.close()
    state = new RuntimeState(join(root, 'ledger.sqlite')); jobs = new ShellJobs(state, root, async () => { callbacks++ })
    expect(jobs.list(binding.id)).toHaveLength(1)
    expect(state.get('execution', id)).toMatchObject({ generation: 7, assignmentId: 'assignment-1', pid: before.pid, nonce: before.nonce, state: 'running' })
    expect(() => jobs.read(id, 'another-worker')).toThrow('not owned')
    expect(() => jobs.kill(id, 'another-worker')).toThrow('not owned')
    const collected = jobs.wait(id, 6000, binding.id); jobs.kill(id, binding.id)
    expect(await collected).toMatchObject({ state: 'killed' })
    expect(callbacks).toBe(0)
    expect(state.get('execution', id)).toMatchObject({ notification: 'collected', kind: 'shell' })
  } finally {
    for (const job of jobs.list(binding.id)) if (['running', 'stopping'].includes(job.state)) jobs.kill(job.id, binding.id)
    jobs.dispose(); state.close(); trashSync(root, { recursive: true, force: true })
  }
}, 12000)
