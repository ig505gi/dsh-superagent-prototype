import { spawn } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { managedFixture, type ManagedFixture } from './fixtures/paseo-runtime.ts'
import { trashSync } from './fixtures/trash.ts'

let fixture: ManagedFixture | undefined
afterEach(async () => {
  if (fixture) { await fixture.close(); trashSync(fixture.root); fixture = undefined }
  vi.restoreAllMocks()
})

function cli(env: Record<string, string | undefined>, args: string[], input = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('superagent-tool', args, { env })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
    child.on('error', reject).on('close', code => { resolve({ code, stdout, stderr }) })
    child.stdin.end(input)
  })
}

it('runs the executable at the front of the session PATH and returns complete resource content through both argument forms', async () => {
  const f = fixture = await managedFixture()
  const owner = f.runtime.masterId, binding = f.adapter.binding(owner)
  const env = { ...process.env, ...f.daemon.creates[0]?.env }
  expect(env.PATH?.split(delimiter)[0]).toBe(join(dirname(binding.file), 'bin'))
  expect(env.SUPERAGENT_CONTROL_FILE).toBe(binding.file)
  const listing = await cli(env, ['list'])
  expect(listing.code).toBe(0)
  expect(JSON.parse(listing.stdout).tools).toContainEqual(expect.objectContaining({
    name: 'orchestrator_read', description: expect.any(String), parameters: expect.objectContaining({ type: 'object' }),
  }))
  const args = { resource: 'prompts/current' }
  const direct = await cli(env, ['call', 'orchestrator_read', JSON.stringify(args)])
  const piped = await cli(env, ['call', 'orchestrator_read', '--stdin'], JSON.stringify(args, null, 2))
  expect(direct.code).toBe(0)
  expect(piped).toEqual(direct)
  const result = JSON.parse(direct.stdout)
  expect(result.structuredContent.text).toEqual(expect.any(String))
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
})

it('returns nonzero for denied and invalid calls and refuses legacy routes and non-POST access', async () => {
  const f = fixture = await managedFixture()
  const owner = f.runtime.masterId, env = { ...process.env, ...f.daemon.creates[0]?.env }
  const denied = await cli(env, ['call', 'superagent_subagent', '{"prompt":"forbidden"}'])
  expect(denied).toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown or unmanaged tool') })
  expect(JSON.parse(denied.stdout)).toMatchObject({ isError: true })
  expect(await cli(env, ['call', 'orchestrator_read', '--stdin'], '{invalid}')).toMatchObject({
    code: 1, stderr: expect.stringContaining('valid JSON'), stdout: '',
  })
  for (const route of ['before-model', 'request-offered', 'request-consumed', 'guard', 'user-shell']) {
    expect((await f.rpc(owner, route, {})).status).toBe(404)
  }
  expect((await f.rpc(owner, 'tools', {}, 'GET')).status).toBe(405)
})
