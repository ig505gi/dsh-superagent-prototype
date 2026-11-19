/** Validate and open Paseo agent deep links returned by the orchestrator backend. */

/**
 * Thrown when a session navigation target cannot be opened safely or does not exist.
 * The management panel catches it to display a localized error message.
 */
export class SessionNavigationError extends Error {
  constructor(readonly code: 'invalid-link' | 'not-found') { super(code) }
}

/**
 * Parse and validate a Paseo agent deep link matching `@getpaseo/protocol`'s `parseAgentDeepLink`
 * (`paseo://h/<serverId>/agent/<agentId>`, rejecting userinfo, port, query, hash, and malformed segments).
 */
export function parsePaseoLink(raw: string): string {
  const text = raw.trim()
  if (!text || text.includes('?') || text.includes('#')) {
    throw new SessionNavigationError('invalid-link')
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new SessionNavigationError('invalid-link')
  }
  if (
    url.protocol !== 'paseo:'
    || url.hostname !== 'h'
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) {
    throw new SessionNavigationError('invalid-link')
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 3 || segments[1] !== 'agent') {
    throw new SessionNavigationError('invalid-link')
  }
  let serverId: string
  let agentId: string
  try {
    serverId = decodeURIComponent(segments[0] ?? '').trim()
    agentId = decodeURIComponent(segments[2] ?? '').trim()
  } catch {
    throw new SessionNavigationError('invalid-link')
  }
  if (!serverId || !agentId) {
    throw new SessionNavigationError('invalid-link')
  }
  return `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`
}

/** Resolve a Paseo agent deep link, verify its format, and open it unless aborted first (silently ignoring aborted outcomes). */
export async function openSessionLink(
  resolve: (id: string, signal: AbortSignal) => Promise<{ url: string }>,
  id: string,
  open: (url: string) => void,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false
  let link: { url: string }
  try {
    link = await resolve(id, signal)
  } catch (error) {
    if (signal.aborted) return false
    throw error
  }
  if (signal.aborted) return false
  open(parsePaseoLink(link.url))
  return true
}
