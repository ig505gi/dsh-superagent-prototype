import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { call, get, gitlabTarget, list, scoped, send } from '../src/sources/gitlab-api.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment = testDeployment({ forge: { ...testDeployment().forge, kind: 'gitlab', host: 'gitlab.example.com', cli: '/opt/agent tools/glab' },
  repository: 'group/sub/widgets' })
const target = gitlabTarget(deployment)
/** A stand-in for the agent's CLI that answers each call with `answer` and records its argv. */
function cli(answer: string) {
  const run = vi.fn(async (_program: string, _args: string[]) => answer)
  return { run, commands: { run } as unknown as Parameters<typeof call>[0] }
}

describe('GitLab calls', () => {
  it('addresses the project by its encoded path on the deployment host, through the agent CLI', async () => {
    expect(scoped(target, 'issues/12')).toBe('projects/group%2Fsub%2Fwidgets/issues/12')
    expect(scoped(target, '')).toBe('projects/group%2Fsub%2Fwidgets')
    expect(target).toEqual({ cli: '/opt/agent tools/glab', host: 'gitlab.example.com', project: 'group/sub/widgets' })
    const { run, commands } = cli('{}')
    await call(commands, target, 'issues/12')
    expect(run).toHaveBeenCalledWith('/opt/agent tools/glab',
      ['api', 'projects/group%2Fsub%2Fwidgets/issues/12', '--hostname', 'gitlab.example.com'])
  })
  it('passes a method and fields, and asks for every page of a list', async () => {
    const { run, commands } = cli('{}')
    await call(commands, target, 'issues', { method: 'POST', fields: ['title=Fix the margin', 'description=@agent-bot please'] })
    expect(run).toHaveBeenCalledWith('/opt/agent tools/glab', ['api', 'projects/group%2Fsub%2Fwidgets/issues', '--hostname', 'gitlab.example.com',
      '-X', 'POST', '-f', 'title=Fix the margin', '-f', 'description=@agent-bot please'])
    await call(commands, target, 'issues', { paginate: true })
    expect(run).toHaveBeenLastCalledWith('/opt/agent tools/glab', ['api', 'projects/group%2Fsub%2Fwidgets/issues', '--hostname', 'gitlab.example.com',
      '--paginate', '--output', 'json'])
  })
  it('validates a single record and refuses an answer that is not one', async () => {
    const schema = z.object({ iid: z.number() })
    expect(await get(cli('{"iid":12}').commands, target, schema, 'issues/12')).toEqual({ iid: 12 })
    await expect(get(cli('{"number":12}').commands, target, schema, 'issues/12')).rejects.toThrow()
  })
  it('flattens a paginated list and counts the records it cannot read', async () => {
    const schema = z.object({ iid: z.number() })
    const tally = { skipped: 0 }
    expect(await list(cli('[{"iid":1},{"broken":true},{"iid":2}]').commands, target, schema, 'issues', {}, tally)).toEqual([{ iid: 1 }, { iid: 2 }])
    expect(tally.skipped).toBe(1)
    // An endpoint that answers with no records at all prints nothing.
    expect(await list(cli('').commands, target, schema, 'issues')).toEqual([])
  })
  it('creates a record with POST and reads the answer back', async () => {
    const { run, commands } = cli('{"id":900,"body":"Done"}')
    const answer = await send(commands, target, z.object({ id: z.number(), body: z.string() }), 'issues/12/notes', { fields: ['body=Done'] })
    expect(answer).toEqual({ id: 900, body: 'Done' })
    expect(run).toHaveBeenCalledWith('/opt/agent tools/glab', ['api', 'projects/group%2Fsub%2Fwidgets/issues/12/notes', '--hostname', 'gitlab.example.com',
      '-X', 'POST', '-f', 'body=Done'])
  })
})