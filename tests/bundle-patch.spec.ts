/** Role preset behavior now belongs to the managed adapter rather than a Cordis bundle patch. */
import { afterEach, expect, it, vi } from 'vitest'
import { managedFixture, type ManagedFixture } from './fixtures/paseo-runtime.ts'
import { trashSync } from './fixtures/trash.ts'
let fixture: ManagedFixture | undefined
afterEach(async () => { if (fixture) { await fixture.close(); trashSync(fixture.root, { recursive: true, force: true }); fixture = undefined }; vi.restoreAllMocks() })
it('keeps only main read, skill, controlled shell and job tools; refuses scheduling, delegation and external document entry points', async () => {
  const f = fixture = await managedFixture(), binding = f.adapter.binding(f.runtime.masterId)
  const reply = await f.rpc(binding.id, 'tools', {}), result = await reply.json() as { tools: { name: string }[] }
  const names = result.tools.map(row => row.name)
  expect(names.filter(name => name.startsWith('superagent_')).sort()).toEqual(['superagent_image', 'superagent_job_kill', 'superagent_job_list', 'superagent_job_output', 'superagent_shell', 'superagent_skill'])
  for (const name of ['write', 'edit', 'superagent_subagent', 'superagent_agents', 'superagent_agent_message', 'schedule', 'ask_user', 'present', 'plan', 'set_goal', 'workflow', 'edit_document']) {
    expect(await f.adapter.authorize(binding, name, {}), name).toBeTruthy()
  }
})
it('exposes six worker business tools and owned controls to the worker', async () => {
  const f = fixture = await managedFixture(), { owner } = await f.acceptedTicket(), binding = f.adapter.binding(owner)
  const result = await (await f.rpc(owner, 'tools', {})).json() as { tools: { name: string }[] }
  expect(result.tools.filter(tool => tool.name.startsWith('orchestrator_'))).toHaveLength(6)
  for (const name of ['orchestrator_read', 'orchestrator_ack', 'orchestrator_report', 'superagent_shell', 'superagent_powershell', 'superagent_job_output', 'superagent_skill',
    'superagent_todo', 'superagent_subagent', 'superagent_subagent_models', 'superagent_agent_message', 'superagent_agents', 'superagent_interrupt', 'superagent_web_search', 'superagent_web_fetch']) {
    expect(await f.adapter.authorize(binding, name, {}), name).toBeUndefined()
  }
  for (const name of ['orchestrator_route', 'orchestrator_settings_save', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'schedule', 'ask_user', 'present', 'set_goal', 'workflow', 'edit_document']) {
    expect(result.tools.some(tool => tool.name === name), name).toBe(false)
    expect(await f.adapter.authorize(binding, name, {}), name).toBeTruthy()
  }
})
