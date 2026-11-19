/** Compile one current application snapshot for Paseo creation and versioned delivery. */
import { createHash } from 'node:crypto'

export interface EffectiveSnapshot {
  role: 'orchestrator' | 'worker'
  promptRevision: number
  policyRevision: string
  skillsRevision: number
  prompt: string
  policy: string
  skills: string
  notices: { id: string; text: string; summary: string }[]
}
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const OPEN = '<superagent_context_v1 '
const CLOSE = '</superagent_context_v1>'
const header = /^<superagent_context_v1 length=(\d+) sha256=([a-f0-9]{64})>\n/

/** Length and digest delimit a whole body, so editable text may contain any closing or nested delimiter literally. */
export function contextBlock(body: string): string { return `${OPEN}length=${body.length} sha256=${sha256(body)}>\n${body}\n${CLOSE}` }

/** Reject malformed owned blocks instead of silently retaining stale policy text. */
export function stripContextBlocks(text: string): { text: string; removed: number } {
  let rest = text, output = '', removed = 0
  for (;;) {
    const start = rest.indexOf(OPEN)
    if (start < 0) {
      if (rest.includes(CLOSE)) throw new Error('Unpaired application context boundary')
      return { text: output + rest, removed }
    }
    const prefix = rest.slice(0, start)
    if (prefix.includes(CLOSE)) throw new Error('Unpaired application context boundary')
    const match = header.exec(rest.slice(start))
    if (!match) throw new Error('Invalid application context boundary')
    const length = Number(match[1])
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid application context length')
    const bodyStart = start + match[0].length, bodyEnd = bodyStart + length
    const body = rest.slice(bodyStart, bodyEnd)
    if (body.length !== length || sha256(body) !== match[2] || rest.slice(bodyEnd, bodyEnd + CLOSE.length + 1) !== `\n${CLOSE}`) {
      throw new Error('Application context integrity check failed')
    }
    output += prefix; rest = rest.slice(bodyEnd + CLOSE.length + 1); removed++
  }
}

/** Render real prompt, policy, skills, and pending notices; no probe fields are part of this contract. */
export function snapshotBody(snapshot: EffectiveSnapshot): string {
  return [
    'APPLICATION INSTRUCTIONS. These current instructions replace every older application revision and take precedence over stock workflow guidance below the provider safety rules.',
    JSON.stringify({ promptRevision: snapshot.promptRevision, policyRevision: snapshot.policyRevision, skillsRevision: snapshot.skillsRevision }),
    '## System\n' + snapshot.prompt, '## Policy\n' + snapshot.policy, '## Skills\n' + snapshot.skills,
    '## Runtime notices\n' + snapshot.notices.map(notice => `[${notice.id}] ${notice.summary}\n${notice.text}`).join('\n\n'),
  ].join('\n\n')
}
