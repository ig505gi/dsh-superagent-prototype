import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { createAuth, loadPassword } from '../src/server/auth.ts'

const password = randomBytes(32).toString('base64url')
let temporary: string | undefined
afterAll(async () => {
  if (temporary && process.platform === 'darwin') await promisify(execFile)('/usr/bin/trash', [temporary])
})

describe('standalone authentication', () => {
  it('loads exactly one password source and hides values and paths on error', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'standalone-auth-'))
    const path = join(temporary, 'password')
    await writeFile(path, `${password}\n`, { mode: 0o600 })
    expect(await loadPassword({ SUPERAGENT_PASSWORD: password })).toBe(password)
    expect(await loadPassword({ SUPERAGENT_PASSWORD_FILE: path })).toBe(password)
    for (const env of [{}, { SUPERAGENT_PASSWORD: '' }, { SUPERAGENT_PASSWORD_FILE: 'relative' },
      { SUPERAGENT_PASSWORD_FILE: join(temporary, 'missing') }, { SUPERAGENT_PASSWORD: password, SUPERAGENT_PASSWORD_FILE: path }]) {
      await expect(loadPassword(env)).rejects.toThrow(/^Standalone login password is not configured$/)
    }
  })

  it('rejects wrong passwords and expires and revokes opaque sessions', () => {
    let now = 1000
    const auth = createAuth({ password, secure: false, sessionTtlMs: 1000, now: () => now })
    expect(auth.login('wrong')).toBeUndefined()
    const token = auth.login(password)!, cookie = auth.sessionCookie(token)
    expect(cookie).toContain('HttpOnly; SameSite=Strict')
    expect(cookie).not.toContain('Secure')
    expect(auth.authenticated(cookie)).toBe(true)
    expect(auth.authenticated(`${cookie}; superagent_session=${token}`)).toBe(false)
    now = 2000
    expect(auth.authenticated(cookie)).toBe(false)
    const next = auth.login(password)!, nextCookie = auth.sessionCookie(next)
    expect(next).not.toBe(token)
    auth.logout(nextCookie)
    expect(auth.authenticated(nextCookie)).toBe(false)
    expect(auth.expiredCookie()).toContain('Max-Age=0')
    expect(createAuth({ password, secure: true }).sessionCookie('value')).toContain('; Secure')
    expect(() => createAuth({ password: '', secure: false })).toThrow(/^Invalid standalone authentication configuration$/)
  })

  it('uses stable cookie names for each instance and revokes only its own token', () => {
    const first = createAuth({ password, secure: false, cookieScope: 'project-a' })
    const second = createAuth({ password, secure: false, cookieScope: 'project-b' })
    const cookiePair = (auth: typeof first) => auth.sessionCookie(auth.login(password)!).split(';')[0]!
    const [a, b] = [cookiePair(first), cookiePair(second)]
    const header = `${a}; ${b}`
    expect(first.authenticated(header)).toBe(true)
    expect(second.authenticated(header)).toBe(true)
    expect(first.authenticated(b)).toBe(false)
    expect(second.authenticated(a)).toBe(false)
    first.logout(header)
    expect(first.authenticated(header)).toBe(false)
    expect(second.authenticated(header)).toBe(true)
    expect(first.expiredCookie().split('=')[0]).toBe(a.split('=')[0])
    expect(createAuth({ password, secure: true, cookieScope: 'project-a' }).expiredCookie().split('=')[0]).toBe(a.split('=')[0])
  })
})
