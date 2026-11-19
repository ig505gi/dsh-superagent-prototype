/** Normalizes GitLab issues, merge requests, notes and pipeline transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/**
 * GitLab numbers issues and merge requests in separate sequences per project, so `iid` alone names no record:
 * every thread id, channel address and trigger id carries the kind.
 */
export type TargetKind = 'issue' | 'mr'
/** A thread is one issue or one merge request, addressed by its kind and project-scoped `iid`. */
export const threadId = (kind: TargetKind, iid: number): string => `${kind}:${iid}`
export const gitlabPage = (host: string, project: string, kind: TargetKind, iid: number): string =>
  `https://${host}/${project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
/** GitLab reply address: the issue or merge request conversation, or one discussion when `discussion` is set. */
export const gitlabChannel = (host: string, project: string, kind: TargetKind, iid: number, detail?: { discussion?: string; note?: number }): ChannelRef =>
  ({ source: SOURCE, thread: `gitlab:${threadId(kind, iid)}`,
    address: { kind, iid: String(iid), url: gitlabPage(host, project, kind, iid),
      ...detail?.discussion ? { discussion: detail.discussion } : {}, ...detail?.note != null ? { note: String(detail.note) } : {} } })
/** A parsed GitLab web link: which record it is and, for a note link, which note. */
export interface GitlabAddress { kind: TargetKind; iid: number; note?: number }
/**
 * Parses a web URL of an issue or merge request on `host` in `project`, optionally pointing at a note.
 * GitLab paths nest (`/-/issues/12`) and note anchors read `#note_123`.
 */
export function gitlabAddress(url: string, host: string, project: string): GitlabAddress | undefined {
  const trimmed = url.split('?')[0]!
  const match = new RegExp(`^https://${escapeRegExp(host)}/${escapeRegExp(project)}/-/(issues|merge_requests)/(\\d+)/?(?:#note_(\\d+))?$`, 'i').exec(trimmed)
  if (!match) return undefined
  return { kind: match[1]!.toLowerCase() === 'issues' ? 'issue' : 'mr', iid: Number(match[2]), ...match[3] ? { note: Number(match[3]) } : {} }
}
/**
 * A GitLab account. `bot` marks automation: service accounts and project access tokens report it, and CI jobs report
 * an empty username, which `bot` then covers too.
 */
export const UserSchema = z.looseObject({ id: z.number(), username: z.string(), name: z.string().nullish(), bot: z.boolean().default(false) })
export type GitlabUser = z.infer<typeof UserSchema>
/** The position of a merge request diff note: the file and line it was written on. */
export const PositionSchema = z.looseObject({ new_path: z.string().nullish(), new_line: z.number().nullish(),
  old_path: z.string().nullish(), old_line: z.number().nullish() })
/**
 * A note, which is GitLab's name for a comment. `system` notes record what the platform did (labels, milestones,
 * assignments, commits) rather than what a person wrote, and never become Triggers.
 */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().default(''), author: UserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), system: z.boolean().default(false),
  position: PositionSchema.nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** An issue or merge request as the list and single-record endpoints return it. */
export const IssueSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(), web_url: z.string(),
})
export type GitlabIssue = z.infer<typeof IssueSchema>
/** A merge request, which adds the fields the delivery path needs. */
export const MergeRequestSchema = IssueSchema.extend({
  source_branch: z.string().nullish(), target_branch: z.string().nullish(),
  sha: z.string().nullish(), draft: z.boolean().nullish(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
})
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
/** True when the account is a person rather than a bot, a service account, or CI. */
export const isHuman = (user: { username: string; bot?: boolean }): boolean => !user.bot && !/\[bot\]$/i.test(user.username)
/** GitLab marks a mention as `@username`, delimited so `@agent` never matches `@agent2`. */
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(username)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: GitlabUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHuman(user) && !sameName(user.username, agent) })
/** The file and line of a diff note, and nothing for a note on the conversation. */
const place = (note: GitlabNote): string => {
  const path = note.position?.new_path ?? note.position?.old_path
  if (!path) return ''
  const line = note.position?.new_line ?? note.position?.old_line
  return line != null ? `${path}:${line}` : path
}
/**
 * Builds a trigger for one note on an issue or merge request. A diff note's text carries its file and line, so the
 * worker reads a review comment the way a person wrote it.
 */
export function noteTrigger(note: GitlabNote, ref: { kind: TargetKind; iid: number; host: string; project: string; discussion?: string }, agent: string): Trigger {
  const id = key('gitlab-note', String(note.id), note.updated_at ?? '')
  const where = place(note)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: threadId(ref.kind, ref.iid) }], ...author(note.author, agent),
    at: note.updated_at ?? note.created_at, text: [where, note.body].filter(Boolean).join('\n\n'),
    ...(mentions(note.body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref.host, ref.project, ref.kind, ref.iid, { ...ref.discussion ? { discussion: ref.discussion } : {}, note: note.id }),
    url: `${gitlabPage(ref.host, ref.project, ref.kind, ref.iid)}#note_${note.id}`,
    meta: { kind: ref.kind, iid: ref.iid, noteId: note.id, ...ref.discussion ? { discussionId: ref.discussion } : {},
      ...where ? { path: note.position?.new_path ?? note.position?.old_path ?? null, line: note.position?.new_line ?? note.position?.old_line ?? null } : {} } }
}
/**
 * Builds the trigger for a newly opened issue or merge request's title and description.
 * @param kind - `issue` or `mr`: the two number independently in GitLab, so the id names the kind.
 */
export function descriptionTrigger(record: GitlabIssue, kind: TargetKind, host: string, project: string, agent: string): Trigger {
  const body = record.description ?? ''
  const url = gitlabPage(host, project, kind, record.iid)
  return { id: key(`gitlab-${kind}`, String(record.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(kind, record.iid) }], ...author(record.author, agent), at: record.created_at,
    text: `${record.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(host, project, kind, record.iid), url,
    meta: { kind, iid: record.iid, ...kind === 'mr' ? { mrAuthor: record.author.username } : {},
      ...kind === 'mr' && (record as GitlabMergeRequest).source_branch ? { branch: (record as GitlabMergeRequest).source_branch } : {} } }
}
/** Builds a trigger for a merge request's pipeline transition; a pipeline names no person, so it has no `channel`. */
export function pipelineTrigger(ref: { kind: TargetKind; iid: number; host: string; project: string }, revision: number, summary: string, author: string): Trigger {
  return { id: key('gitlab-pipeline', ref.kind, String(ref.iid), String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(ref.kind, ref.iid) }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url: gitlabPage(ref.host, ref.project, ref.kind, ref.iid),
    meta: { kind: ref.kind, iid: ref.iid, pipeline: true, revision, ...ref.kind === 'mr' ? { mrAuthor: author } : {} } }
}
/** Builds a trigger for a default-branch pipeline transition, which belongs to the branch thread rather than to a record. */
export function branchPipelineTrigger(branch: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-pipeline', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { pipeline: true, branch, revision } }
}