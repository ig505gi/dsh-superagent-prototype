import { afterEach, expect, it, vi } from 'vitest'
import { resolveRoleModel } from '../src/app/role-models.ts'
import { assessorProfile, executorProfile, managedFixture, type ManagedFixture } from './fixtures/paseo-runtime.ts'
import { trashSync } from './fixtures/trash.ts'

let fixture: ManagedFixture | undefined
afterEach(async () => {
  if (fixture) { await fixture.close(); trashSync(fixture.root); fixture = undefined }
  vi.restoreAllMocks()
})

it('reads Pi and Codex profiles and reports unavailable providers without a fallback', async () => {
  const { adapter, daemon } = fixture = await managedFixture()
  const offline = { profileId: 'offline', name: 'Offline', provider: 'factory-droid' }
  daemon.profiles.push(offline)
  const catalog = await adapter.modelCatalog()
  expect(catalog).toMatchObject({ profiles: [
    { ...assessorProfile, available: true }, { ...executorProfile, available: true }, { ...offline, available: false },
  ], failures: [] })
  await expect(resolveRoleModel(adapter.context, assessorProfile.profileId)).resolves.toEqual(assessorProfile)
  await expect(resolveRoleModel(adapter.context, executorProfile.profileId)).resolves.toEqual(executorProfile)
  await expect(resolveRoleModel(adapter.context, offline.profileId)).rejects.toThrow('Choose an available profile')
})

it('keeps a catalog failure readable and omits malformed or blank launch fields', async () => {
  const { adapter, daemon } = fixture = await managedFixture()
  daemon.profiles = [{ ...assessorProfile, model: '', modeId: '', thinkingOptionId: ' ' }, { ...executorProfile, name: '' }]
  vi.spyOn(daemon.client, 'listAvailableProviders').mockRejectedValue(new Error('transport details'))
  const catalog = await adapter.modelCatalog()
  expect(JSON.parse(JSON.stringify(catalog.profiles))).toEqual([{ profileId: assessorProfile.profileId, name: assessorProfile.name,
    provider: assessorProfile.provider, available: false }])
  expect(catalog.failures).toMatchObject([{ id: 'providers' }])
  expect(JSON.stringify(catalog)).not.toContain('transport details')
})
