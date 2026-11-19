/**
 * The GitLab REST calls a Source makes, as `glab api` invocations against the deployment's instance.
 *
 * `glab` addresses a project by its URL-encoded full path, prints one JSON document per call, and merges the pages of a
 * paginated list into one JSON array, so callers never see pagination.
 */
import type { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'

/** What a GitLab call needs from the deployment: the agent's CLI, its instance and the project path. */
export interface GitlabTarget { cli: string; host: string; project: string }
export const gitlabTarget = (deployment: Deployment): GitlabTarget =>
  ({ cli: deployment.forge.cli, host: deployment.forge.host, project: deployment.repository })
/** `glab` reads the host from the current git directory, which a ticket directory also is: name it on every call. */
export const scoped = (target: GitlabTarget, path: string): string => `projects/${encodeURIComponent(target.project)}${path ? `/${path}` : ''}`
/** Query parameters and form fields, written `key=value`; `glab` infers their type. */
export interface CallOptions { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; fields?: readonly string[]; paginate?: boolean }
const argv = (target: GitlabTarget, path: string, options: CallOptions = {}): string[] => ['api', scoped(target, path), '--hostname', target.host,
  ...options.method ? ['-X', options.method] : [],
  ...(options.fields ?? []).flatMap(field => ['-f', field]),
  ...options.paginate ? ['--paginate', '--output', 'json'] : []]
/** Runs one GitLab call and returns its raw output. */
export function call(commands: Pick<Commands, 'run'>, target: GitlabTarget, path: string, options?: CallOptions): Promise<string> {
  return commands.run(target.cli, argv(target, path, options))
}
/** Runs one call whose answer is a single JSON document: an endpoint, not a list. */
export async function get<T>(commands: Pick<Commands, 'run'>, target: GitlabTarget, schema: z.ZodType<T>, path: string, options: CallOptions = {}): Promise<T> {
  return schema.parse(JSON.parse(await call(commands, target, path, options)))
}
/**
 * Reads every page of a list, skipping records that fail validation.
 * @param tally - counts the skipped records, so a Source can report unreadable ones without failing the round.
 */
export async function list<T>(commands: Pick<Commands, 'run'>, target: GitlabTarget, item: z.ZodType<T>, path: string, options: CallOptions = {}, tally?: Tally): Promise<T[]> {
  const text = await call(commands, target, path, { ...options, paginate: true })
  // `glab --paginate --output json` prints one array; an empty answer means no records at all.
  const page = text.trim() ? JSON.parse(text) as unknown : []
  return validItems(item, Array.isArray(page) ? page : [page], tally)
}
/** Writes one record and returns its JSON answer, which GitLab sends back for notes and status changes. */
export async function send<T>(commands: Pick<Commands, 'run'>, target: GitlabTarget, schema: z.ZodType<T>, path: string, options: CallOptions): Promise<T> {
  return schema.parse(JSON.parse(await call(commands, target, path, { ...options, method: options.method ?? 'POST' })))
}