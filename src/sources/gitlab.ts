/** GitLab Source: tracks only merge requests bound to open tickets and their CI. */
import type { Context } from '../runtime/context.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key } from '../core/index.ts'
import { GitlabProjectSchema } from '../deployment.ts'
import { KV } from '../kv.ts'
import { mergeRequestsOf, observeMr, readMr, type GitlabMr } from './gitlab-mr.ts'
import { SOURCE, pipelineTrigger, threadId } from './gitlab-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const ConfigSchema = GitlabProjectSchema.extend({ pollSeconds: z.number().int().min(10).max(3600).default(60) }).strict()
export type GitlabConfig = z.infer<typeof ConfigSchema>
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '跟踪工单关联的 MR 和 CI。', en: 'Tracks merge requests and CI belonging to tickets.' },
  schema: ConfigSchema,
  fields: [
    { key: 'host', type: 'text', label: { zh: '实例地址', en: 'Instance host' }, hint: { zh: '不含 https://，例如 gitlab.example.com。', en: 'Without https://, for example gitlab.example.com.' } },
    { key: 'project', type: 'text', label: { zh: '项目路径', en: 'Project path' }, hint: { zh: '例如 group/project。', en: 'For example group/project.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 glab', en: 'Agent glab' } },
    { key: 'pollSeconds', type: 'number', min: 10, max: 3600, advanced: true, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['gitlab'],
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 实例地址', en: 'GitLab instance host' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: 'GitLab 项目路径', en: 'GitLab project path' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号', en: 'Agent GitLab account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体的提交邮箱', en: 'Agent commit email' } },
    ],
    values: ({ deployment }) => ({ DSH_SUPERAGENT_GITLAB_HOST: deployment.forge.host, DSH_SUPERAGENT_GITLAB_PROJECT: deployment.repository,
      DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.forge.login, DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.forge.noreply }),
  },
}

export async function pollMr(ctx: SourceContext, mr: GitlabMr): Promise<void> {
  observeMr(ctx, mr)
  if (mr.state !== 'opened') return
  const pipeline = mr.head_pipeline
  const matching = pipeline && pipeline.sha === mr.sha ? pipeline : undefined
  const status = matching?.status ?? 'unknown'
  const fingerprint = key(mr.sha ?? '', String(matching?.id ?? ''), status)
  const previous = ctx.state.get(KV.gitlab.ci(mr.iid))
  const revision = previous ? previous.revision + 1 : 0
  if (previous?.fingerprint !== fingerprint) {
    if (previous || status === 'failed' || status === 'canceled') {
      const summary = `GitLab MR !${mr.iid} pipeline: ${status}${matching?.web_url ? ` (${matching.web_url})` : ''}.`
      await ctx.receive(pipelineTrigger({ kind: 'mr', iid: mr.iid, host: ctx.deployment.forge.host, project: ctx.deployment.repository },
        revision, summary, mr.author.username))
    }
    ctx.state.set(KV.gitlab.ci(mr.iid), { fingerprint, revision })
  }
  ctx.threads.describe(`${SOURCE}:${threadId('mr', mr.iid)}`, { facts: {
    ci: { label: 'CI', value: status, ...status === 'failed' || status === 'canceled' ? { problem: true } : {} },
    autoMerge: mr.auto_merge_enabled || mr.merge_when_pipeline_succeeds ? { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } } : null,
  } })
}

export async function pollGitlab(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const ids = [...new Set(ctx.tickets.open().flatMap(ticket => mergeRequestsOf(ticket, true)))]
  const errors: string[] = []
  for (const iid of ids) {
    if (signal?.aborted) return
    try { await pollMr(ctx, await readMr(ctx, iid, signal)) }
    catch { if (!signal?.aborted) errors.push(`!${iid}`) }
  }
  if (errors.length) throw new Error(`Cannot read merge requests ${errors.join(', ')}`)
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    if (!config || ctx.deployment.forge.kind !== 'gitlab') ctx.report('gitlab', health('paused', 'sourceOff'))
    else {
      try { await pollGitlab(ctx, signal); if (!signal.aborted) ctx.report('gitlab', { state: 'ready', detail: 'Merge requests and CI checked', at: new Date().toISOString() }) }
      catch (error) { if (!signal.aborted) ctx.report('gitlab', { state: 'error', detail: String(error) }) }
    }
    await delay((config?.pollSeconds ?? 60) * 1000, undefined, { signal }).catch(() => {})
  }
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind), controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
