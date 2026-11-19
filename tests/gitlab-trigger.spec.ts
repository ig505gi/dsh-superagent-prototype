import { describe, expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { branchPipelineTrigger, descriptionTrigger, gitlabAddress, gitlabChannel, gitlabPage, isHuman, mentions, noteTrigger,
  pipelineTrigger, threadId, type GitlabNote } from '../src/sources/gitlab-trigger.ts'

const HOST = 'gitlab.example.com'
const PROJECT = 'group/sub/widgets'
const AGENT = 'agent-bot'
const person = { id: 3, username: 'alice', name: 'Alice', bot: false }
const bot = { id: 4, username: 'renovate', name: 'Renovate', bot: true }
const note = (overrides: Partial<GitlabNote> = {}): GitlabNote => ({ id: 900, body: 'Please look', author: person,
  created_at: '2026-01-02T03:04:05Z', updated_at: null, system: false, position: null, ...overrides })

describe('GitLab links and addresses', () => {
  it('builds the web address of an issue or merge request on the instance', () => {
    expect(gitlabPage(HOST, PROJECT, 'issue', 12)).toBe(`https://${HOST}/${PROJECT}/-/issues/12`)
    expect(gitlabPage(HOST, PROJECT, 'mr', 12)).toBe(`https://${HOST}/${PROJECT}/-/merge_requests/12`)
  })
  it('parses its own links back, including note anchors, and refuses another project or host', () => {
    expect(gitlabAddress(`https://${HOST}/${PROJECT}/-/issues/12`, HOST, PROJECT)).toEqual({ kind: 'issue', iid: 12 })
    expect(gitlabAddress(`https://${HOST}/${PROJECT}/-/merge_requests/7#note_555`, HOST, PROJECT)).toEqual({ kind: 'mr', iid: 7, note: 555 })
    expect(gitlabAddress(`https://${HOST}/${PROJECT}/-/issues/12?foo=1`, HOST, PROJECT)).toEqual({ kind: 'issue', iid: 12 })
    expect(gitlabAddress(`https://${HOST}/group/other/-/issues/12`, HOST, PROJECT)).toBeUndefined()
    expect(gitlabAddress(`https://gitlab.com/${PROJECT}/-/issues/12`, HOST, PROJECT)).toBeUndefined()
    // A path prefix that merely starts the same way is not this project.
    expect(gitlabAddress(`https://${HOST}/${PROJECT}-next/-/issues/12`, HOST, PROJECT)).toBeUndefined()
  })
  it('keys the channel by kind and number, because GitLab numbers issues and merge requests separately', () => {
    expect(threadId('issue', 12)).toBe('issue:12')
    expect(threadId('mr', 12)).toBe('mr:12')
    expect(gitlabChannel(HOST, PROJECT, 'mr', 12).thread).toBe('gitlab:mr:12')
    expect(gitlabChannel(HOST, PROJECT, 'issue', 12, { discussion: 'abc', note: 9 }).address)
      .toEqual({ kind: 'issue', iid: '12', url: `https://${HOST}/${PROJECT}/-/issues/12`, discussion: 'abc', note: '9' })
  })
})

describe('GitLab senders', () => {
  it('counts bots, service accounts and CI as automation', () => {
    expect(isHuman(person)).toBe(true)
    expect(isHuman(bot)).toBe(false)
    expect(isHuman({ username: 'deployer[bot]' })).toBe(false)
    expect(isHuman({ username: 'ci-token', bot: true })).toBe(false)
  })
  it('reads a mention only when it is the whole handle', () => {
    expect(mentions(`@${AGENT} please`, AGENT)).toBe(true)
    expect(mentions(`thanks @${AGENT}.`, AGENT)).toBe(true)
    expect(mentions(`@${AGENT}2 please`, AGENT)).toBe(false)
    expect(mentions(`mail me at a@${AGENT}`, AGENT)).toBe(false)
    expect(mentions('no mention', AGENT)).toBe(false)
  })
})

describe('GitLab triggers', () => {
  it('stores one description trigger per record, stable across polls, separate by kind', () => {
    const record = { iid: 12, title: 'Fix the margin', description: 'Details', state: 'opened', author: person,
      created_at: '2026-01-02T03:04:05Z', updated_at: null, web_url: `https://${HOST}/${PROJECT}/-/issues/12` }
    const issue = descriptionTrigger(record, 'issue', HOST, PROJECT, AGENT)
    expect(issue.id).toBe(key('gitlab-issue', '12'))
    expect(descriptionTrigger(record, 'issue', HOST, PROJECT, AGENT).id).toBe(issue.id)
    // Merge request 12 is another record with the same number, and must not collide with issue 12.
    expect(descriptionTrigger(record, 'mr', HOST, PROJECT, AGENT).id).toBe(key('gitlab-mr', '12'))
    expect(issue.threads).toEqual([{ source: 'gitlab', id: 'issue:12' }])
    expect(issue.text).toBe('Fix the margin\n\nDetails')
    expect(issue.actor).toEqual({ source: 'gitlab', id: 'alice' })
    expect(issue.human).toBe(true)
    expect(issue.channel?.address).toMatchObject({ kind: 'issue', iid: '12', url: `https://${HOST}/${PROJECT}/-/issues/12` })
    expect(issue).not.toHaveProperty('addressed')
  })
  it('marks a description that mentions the agent, and one written by the agent as its own automation', () => {
    const record = { iid: 5, title: 'Ask', description: `@${AGENT} rename this`, state: 'opened', author: person,
      created_at: '2026-01-02T03:04:05Z', updated_at: null, web_url: '' }
    expect(descriptionTrigger(record, 'issue', HOST, PROJECT, AGENT).addressed).toBe('mention')
    const own = descriptionTrigger({ ...record, author: { id: 1, username: AGENT, bot: true } }, 'issue', HOST, PROJECT, AGENT)
    expect(own.human).toBe(false)
  })
  it('turns a note into a trigger in the record thread, with a stable id and its own link', () => {
    const before = { kind: 'issue' as const, iid: 12, host: HOST, project: PROJECT }
    const trigger = noteTrigger(note({ body: `@${AGENT} please look` }), before, AGENT)
    expect(trigger.id).toBe(key('gitlab-note', '900', ''))
    expect(trigger.threads).toEqual([{ source: 'gitlab', id: 'issue:12' }])
    expect(trigger.addressed).toBe('mention')
    expect(trigger.url).toBe(`https://${HOST}/${PROJECT}/-/issues/12#note_900`)
    expect(trigger.meta).toEqual({ kind: 'issue', iid: 12, noteId: 900 })
    // An edited note is another event: the id carries `updated_at`.
    expect(noteTrigger(note({ updated_at: '2026-01-03T00:00:00Z' }), before, AGENT).id).toBe(key('gitlab-note', '900', '2026-01-03T00:00:00Z'))
  })
  it('puts a diff note on the merge request with its file and line, and keeps its discussion for replies', () => {
    const trigger = noteTrigger(note({ position: { new_path: 'src/app.ts', new_line: 42, old_path: 'src/app.ts', old_line: null } }),
      { kind: 'mr', iid: 7, host: HOST, project: PROJECT, discussion: 'disc-1' }, AGENT)
    expect(trigger.text).toBe('src/app.ts:42\n\nPlease look')
    expect(trigger.channel?.address).toMatchObject({ kind: 'mr', iid: '7', discussion: 'disc-1', note: '900' })
    expect(trigger.meta).toMatchObject({ kind: 'mr', iid: 7, discussionId: 'disc-1', path: 'src/app.ts', line: 42 })
  })
  it('keeps a bot note as a trigger no person can be credited for', () => {
    const trigger = noteTrigger(note({ author: bot }), { kind: 'issue', iid: 1, host: HOST, project: PROJECT }, AGENT)
    expect(trigger.human).toBe(false)
    expect(trigger.actor).toEqual({ source: 'gitlab', id: 'renovate' })
  })
  it('numbers pipeline triggers by revision so each transition is stored once', () => {
    const ref = { kind: 'mr' as const, iid: 7, host: HOST, project: PROJECT }
    const first = pipelineTrigger(ref, 0, 'pipeline failed', 'alice')
    expect(first.id).toBe(key('gitlab-pipeline', 'mr', '7', '0'))
    expect(pipelineTrigger(ref, 1, 'pipeline passed', 'alice').id).not.toBe(first.id)
    expect(first.human).toBe(false)
    expect(first.channel).toBeUndefined()
    expect(first.threads).toEqual([{ source: 'gitlab', id: 'mr:7' }])
    const branch = branchPipelineTrigger('main', 0, 'pipeline failed', `https://${HOST}/${PROJECT}/-/pipelines/9`)
    expect(branch.threads).toEqual([{ source: 'gitlab', id: 'ci:main' }])
    expect(branch.channel).toBeUndefined()
  })
})