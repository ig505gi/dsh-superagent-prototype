/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { SubprocessRuntime } from './runtime/types.ts'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const machineSchema = z.object({
  stateDir: z.string().regex(/^\//),
  promptMaxChars: z.number().int().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).default(100000),
  admissionContextMaxPages: z.number().int().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).default(10),
  admissionContextTimeoutMs: z.number().int().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).default(15000),
}).passthrough()
/** Parse machine limits without depending on a host configuration framework. */
export const Config = Object.assign((input: unknown): DeploymentConfig => {
  const value = machineSchema.parse(input)
  return { ...value, promptMaxChars: { get: () => value.promptMaxChars }, admissionContextMaxPages: { get: () => value.admissionContextMaxPages },
    admissionContextTimeoutMs: { get: () => value.admissionContextTimeoutMs } }
}, { dict: machineSchema.shape })
export type DeploymentConfig = Machine & Record<string, unknown>
export interface Machine {
  stateDir: string
  promptMaxChars: { get(): number }
  admissionContextMaxPages: { get(): number }
  admissionContextTimeoutMs: { get(): number }
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const GitlabProjectSchema = z.object({
  host: z.string().trim().regex(/^([A-Za-z0-9.-]+(:\d{1,5})?)?$/, 'gitlab.example.com').default(''),
  project: z.string().trim().regex(/^([A-Za-z0-9_.\-/]+)?$/, 'group/project').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape),
  gitlab: Object.keys(GitlabProjectSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

/** The code host a deployment acts on; its CLI is the account the agent comments, pushes and opens merges as. */
export type ForgeKind = 'github' | 'gitlab'
export interface Forge {
  kind: ForgeKind
  /** Host name without a scheme, such as `github.com` or `gitlab.example.com`: git credentials and links are keyed by it. */
  host: string
  cli: string
  login: string
  noreply: string
}

export interface Deployment extends Machine {
  /** The repository on the forge: `owner/name`, or a GitLab project path such as `group/sub/project`. */
  repository: string
  forge: Forge
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveGithub(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, forge: { kind: 'github', host: 'github.com', cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

/** The host name of an instance address, without the port it may be served on (`gitlab.example.com:8443`). */
export const hostnameOf = (host: string): string => host.replace(/:\d+$/, '')
/** The GitLab instance fields, in the shape `glab api` reports them. */
const GitlabUser = z.object({ id: z.number().int().positive(), username: z.string().min(1), email: z.string().optional() })
const GitlabProject = z.object({ path_with_namespace: z.string().min(1),
  permissions: z.object({ project_access: z.object({ access_level: z.number().int() }).nullish(),
    group_access: z.object({ access_level: z.number().int() }).nullish() }).nullish() })
/** Developer and above may push; GitLab reports Guest as 10, Reporter as 20 and Developer as 30. */
const MAY_PUSH = 30
/**
 * Verify the agent's GitLab CLI identity and push access to the configured project on a self-hosted instance.
 * `project` is a full path such as `group/sub/project`, which the API addresses in its URL-encoded form.
 */
export async function resolveGitlab(machine: Machine, gitlab: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const account = GitlabProjectSchema.parse(gitlab ?? {})
  if (!account.host) throw new SetupError('gitlabHostUnset')
  if (!account.project) throw new SetupError('projectUnset')
  if (!account.cli) throw new SetupError('gitlabCliUnset')
  let cli: string
  try { cli = executable(account.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user', '--hostname', account.host]).catch((error: unknown) => { throw new SetupError('gitlabCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GitlabUser, text)
  if (!agent) throw new SetupError('gitlabCliNoAccount')
  const id = encodeURIComponent(account.project)
  const access = parsed(GitlabProject, await probe([cli, 'api', `projects/${id}`, '--hostname', account.host]).catch((error: unknown) => {
    throw new SetupError('projectUnreadable', { account: agent.username, repository: account.project, output: reason(error) })
  }))
  if (!access) throw new SetupError('projectUnreported', { repository: account.project })
  const repository = access.path_with_namespace
  // A project without either permission block is one the agent can read but not push to; GitLab omits them for outsiders.
  const level = Math.max(access.permissions?.project_access?.access_level ?? 0, access.permissions?.group_access?.access_level ?? 0)
  if (level < MAY_PUSH) throw new SetupError('projectReadOnly', { account: agent.username, repository })
  // A commit address needs a domain, not a port: an instance served on one keeps it in `host` alone.
  const noreply = agent.email || `${agent.username}@users.noreply.${hostnameOf(account.host)}`
  return { ...machine, repository, forge: { kind: 'gitlab', host: account.host, cli, login: agent.username, noreply } }
}

/**
 * Resolve the deployment's forge from the Source blocks: GitHub when its repository is set, GitLab when its instance or
 * project is, and one of them only. Machine limits apply to both.
 */
export async function resolveDeployment(machine: Machine, sources: { github?: unknown; gitlab?: unknown }, probe: Probe,
  path = process.env.PATH ?? ''): Promise<Deployment> {
  const github = GithubAccountsSchema.parse(sources.github ?? {})
  const gitlab = GitlabProjectSchema.parse(sources.gitlab ?? {})
  const wantsGithub = !!github.repository
  const wantsGitlab = !!gitlab.host || !!gitlab.project
  if (wantsGithub && wantsGitlab) throw new SetupError('forgeAmbiguous')
  return wantsGitlab ? await resolveGitlab(machine, gitlab, probe, path) : await resolveGithub(machine, github, probe, path)
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
