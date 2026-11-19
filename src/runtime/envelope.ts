/** Stable remote IDs and self-identifying delivery frames without exposing caller-controlled authorization fields. */
import { createHash } from 'node:crypto'
export function stableId(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export function deliveryBody(id: string, text: string): string {
  return `[superagent-delivery ${Buffer.from(JSON.stringify({ id, digest: digest(text) })).toString('base64url')}]\n${text}`
}
export function deliveryReference(text: string): { id: string; digest: string } | undefined {
  const match = /^\[superagent-delivery ([A-Za-z0-9_-]+)\]\n/.exec(text)
  if (!match) return
  try {
    const ref = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as { id?: unknown; digest?: unknown }
    if (typeof ref.id === 'string' && typeof ref.digest === 'string' && digest(text.slice(match[0].length)) === ref.digest) {
      return { id: ref.id, digest: ref.digest }
    }
  } catch { /* User text resembling an envelope is not a receipt. */ }
}
