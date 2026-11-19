import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const COOKIE = 'superagent_session'
const MAX_PASSWORD_BYTES = 1024
const DEFAULT_SESSION_MS = 8 * 60 * 60 * 1000
const MAX_SESSIONS = 1000

function validPassword(value: string): boolean {
  const size = Buffer.byteLength(value, 'utf8')
  return size > 0 && size <= MAX_PASSWORD_BYTES
}

/** Read the login password outside public config; failures never include values or file paths. */
export async function loadPassword(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const value = env.SUPERAGENT_PASSWORD, file = env.SUPERAGENT_PASSWORD_FILE
  if ((value !== undefined && file !== undefined) || (value === undefined && file === undefined)) throw new Error('Standalone login password is not configured')
  let password: string
  if (file !== undefined) {
    if (!isAbsolute(file)) throw new Error('Standalone login password is not configured')
    try { password = (await readFile(file, 'utf8')).replace(/\r?\n$/, '') }
    catch { throw new Error('Standalone login password is not configured') }
  } else password = value!
  if (!validPassword(password)) throw new Error('Standalone login password is not configured')
  return password
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()
const key = (token: string): string => digest(token).toString('hex')

function cookieToken(header: string | undefined, name: string): string | undefined {
  const matches = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (matches.length !== 1) return
  const token = matches[0]!.slice(name.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined
}

export interface AuthOptions {
  password: string
  secure: boolean
  cookieScope?: string
  sessionTtlMs?: number
  now?: () => number
}

/** Opaque sessions are held in memory and become invalid when the process restarts. */
export function createAuth({ password, secure, cookieScope, sessionTtlMs = DEFAULT_SESSION_MS, now = Date.now }: AuthOptions) {
  if (!validPassword(password) || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > DEFAULT_SESSION_MS) {
    throw new Error('Invalid standalone authentication configuration')
  }
  const passwordHash = digest(password), sessions = new Map<string, number>()
  const name = cookieScope === undefined ? COOKIE : `${COOKIE}_${key(cookieScope).slice(0, 16)}`
  const attributes = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  function prune(): void { for (const [id, expires] of sessions) if (expires <= now()) sessions.delete(id) }
  return {
    login(candidate: string): string | undefined {
      const matches = timingSafeEqual(passwordHash, digest(candidate))
      if (!validPassword(candidate) || !matches) return
      prune()
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
      const token = randomBytes(32).toString('base64url')
      sessions.set(key(token), now() + sessionTtlMs)
      return token
    },
    authenticated(cookie: string | undefined): boolean {
      const token = cookieToken(cookie, name)
      if (!token) return false
      const id = key(token), expires = sessions.get(id)
      if (expires === undefined) return false
      if (expires <= now()) { sessions.delete(id); return false }
      return true
    },
    logout(cookie: string | undefined): void {
      const token = cookieToken(cookie, name)
      if (token) sessions.delete(key(token))
    },
    sessionCookie(token: string): string { return `${name}=${token}; ${attributes}; Max-Age=${Math.ceil(sessionTtlMs / 1000)}` },
    expiredCookie(): string { return `${name}=; ${attributes}; Max-Age=0` },
  }
}

export type StandaloneAuth = ReturnType<typeof createAuth>
