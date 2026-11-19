/** GitLab merge request binding and lifecycle for tickets started outside GitLab. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { get, gitlabTarget } from './gitlab-api.ts'
import { SOURCE, gitlabPage, threadId } from './gitlab-trigger.ts'
import type { SourceContext } from './host.ts'

const PipelineSchema = z.looseObject({ id: z.number(), sha: z.string(), status: z.string(), web_url: z.string().nullish() })
const MrSchema = z.looseObject({
  iid: z.number().int().positive(), title: z.string(), state: z.string(), web_url: z.string(),
  author: z.looseObject({ username: z.string() }), source_branch: z.string(),
  source_project_id: z.number().nullish(), target_project_id: z.number().nullish(), sha: z.string().nullish(),
  head_pipeline: PipelineSchema.nullish(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  merge_when_pipeline_succeeds: z.boolean().optional(), auto_merge_enabled: z.boolean().optional(),
})
export type GitlabMr = z.infer<typeof MrSchema>
export const readMr = (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<GitlabMr> =>
  get(ctx.commands.withSignal(signal), gitlabTarget(ctx.deployment), MrSchema, `merge_requests/${iid}`)

const mrNumber = (thread: string): number | undefined => {
  const found = /^gitlab:mr:([1-9]\d*)$/.exec(thread)
  return found ? Number(found[1]) : undefined
}
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrNumber(item.thread) ?? [])

/** Bind only a same-project MR authored by the agent on this ticket's branch. */
export function claimMr(ctx: SourceContext, ticketId: string, mr: GitlabMr): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended before the merge request was bound'
  const ownProject = mr.source_project_id != null && mr.source_project_id === mr.target_project_id
  const ownBranch = !!ticket.execution?.name && mr.source_branch.split('/').at(-1) === ticket.execution.name
  if (!ownProject || !ownBranch || !sameName(mr.author.username, ctx.deployment.forge.login)) {
    return 'Merge request must belong to this project, the agent account and this ticket branch'
  }
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'Merge request already belongs to another active ticket'
  const id = threadId('mr', mr.iid)
  const followed = ticket.follows?.find(item => item.thread === `${SOURCE}:${id}`)
  if (mr.state === 'opened' && (!followed || followed.closed || !followed.own)) {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id }, true)
  }
  ctx.threads.patch(`${SOURCE}:${id}`, { iid: mr.iid, kind: 'mr', url: mr.web_url, title: mr.title })
  ctx.threads.describe(`${SOURCE}:${id}`, { label: `!${mr.iid} ${mr.title}`, url: mr.web_url })
  return undefined
}

export function observeMr(ctx: SourceContext, mr: GitlabMr): void {
  if (mr.state !== 'merged' && mr.state !== 'closed') return
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  ctx.tickets.threadClosed({ source: SOURCE, id: threadId('mr', mr.iid) }, mr.state === 'merged' ? 'merged' : 'closed',
    mr.merged_at ?? mr.closed_at ?? new Date().toISOString())
}

export function mrEndNotices(ticket: Ticket, request: string, host: string, project: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = mrNumber(follow.thread)!
  const url = gitlabPage(host, project, 'mr', iid)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese ? `[MR !${iid}](${url}) ${outcome === 'merged' ? '已合并' : '已关闭，未合并'}。`
    : `[MR !${iid}](${url}) ${outcome === 'merged' ? 'has merged' : 'was closed without merging'}.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
