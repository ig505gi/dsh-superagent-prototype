/** Resolve a role's selection from the live Paseo catalog before saving its launch configuration. */
import type { Context } from '../runtime/context.ts'
import type { RoleModel } from '../policy.ts'

export async function resolveRoleModel(ctx: Context, profileId: string): Promise<RoleModel> {
  const catalog = await ctx.sessionController.modelCatalog()
  const profile = catalog.profiles.find(item => item.profileId === profileId)
  if (!profile?.available) throw new Error(catalog.failures[0]?.message ?? 'Choose an available profile from the Paseo daemon.')
  const { available: _available, ...selection } = profile
  return selection
}
