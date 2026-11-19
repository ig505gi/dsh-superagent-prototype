import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createAuth } from './auth.ts'
import { normalizeAuthority, type StandaloneConfig } from './config.ts'

export type ManagementHandler = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>
export interface StandaloneServerOptions {
  config: StandaloneConfig
  password: string
  staticRoot: string
  managementHandler: ManagementHandler
  managementReady?: () => boolean
  sessionTtlMs?: number
  now?: () => number
}

const LOGIN_LIMIT = 8 * 1024
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
}
const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Superagent 登录</title><style>body{font:16px system-ui,sans-serif;background:#f5f5f4;color:#292524;display:grid;place-items:center;min-height:100vh;margin:0}main{background:white;border:1px solid #e7e5e4;border-radius:12px;padding:32px;width:min(320px,calc(100vw - 80px))}h1{font-size:22px}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:10px;margin-top:10px;border:1px solid #a8a29e;border-radius:6px}button{background:#292524;color:white;cursor:pointer}</style></head><body><main><h1>Superagent</h1><form method="post" action="/login"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">登录</button></form></main></body></html>`

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function oneHeader(req: IncomingMessage, name: string): boolean {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) count++
  return count <= 1
}

function sameSite(req: IncomingMessage, config: StandaloneConfig): boolean {
  if (!oneHeader(req, 'host') || !oneHeader(req, 'origin') || !oneHeader(req, 'sec-fetch-site')) return false
  const scheme = new URL(config.publicOrigin).protocol as 'http:' | 'https:'
  const host = req.headers.host && normalizeAuthority(req.headers.host, scheme)
  if (!host || !config.allowedHosts.includes(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `${scheme}//${host}`) return false
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}

function pathOf(req: IncomingMessage): string | undefined {
  const target = req.url ?? '/'
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) return
  try {
    const path = decodeURIComponent(target.split('?')[0]!)
    if (/[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return
    return path
  } catch { return }
}

/** Rejects login bodies before they can exceed the authentication byte limit. */
class BodyTooLarge extends Error {}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const length = req.headers['content-length']
    if (length && Number(length) > LOGIN_LIMIT) { req.resume(); reject(new BodyTooLarge()); return }
    let size = 0
    const parts: Buffer[] = []
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted) }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > LOGIN_LIMIT) { cleanup(); req.resume(); reject(new BodyTooLarge()); return }
      parts.push(chunk)
    }
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(parts).toString('utf8')) }
    const onError = () => { cleanup(); reject(new Error('Unable to read request')) }
    const onAborted = () => { cleanup(); reject(new Error('Unable to read request')) }
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted)
  })
}

function passwordFrom(body: string, contentType: string): string | undefined {
  if (contentType === 'application/json') {
    try {
      const value: unknown = JSON.parse(body)
      return value && typeof value === 'object' && 'password' in value && typeof value.password === 'string' ? value.password : undefined
    } catch { return }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const fields = new URLSearchParams(body), passwords = fields.getAll('password')
    return passwords.length === 1 ? passwords[0] : undefined
  }
  return
}

function inside(root: string, path: string): boolean {
  const name = relative(root, path)
  return !!name && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
}

async function staticFile(root: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const target = path === '/' || path === '/index.html' ? 'index.html' : path.startsWith('/assets/') ? path.slice(1) : undefined
  if (!target) return false
  const file = resolve(root, target)
  if (!inside(root, file)) return false
  try {
    let current = root
    for (const part of target.split('/')) {
      current = resolve(current, part)
      if ((await lstat(current)).isSymbolicLink()) return false
    }
    const canonical = await realpath(file)
    if (!inside(root, canonical)) return false
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await handle.stat()).isFile()) return false
      const body = await handle.readFile()
      res.writeHead(200, { 'content-type': TYPES[extname(canonical).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache', 'content-length': body.length })
      res.end(req.method === 'HEAD' ? undefined : body)
      return true
    } finally { await handle.close() }
  } catch { return false }
}

/** Creates, but does not listen on, a Node HTTP server. The integrator owns listen and close. */
export async function createStandaloneServer(options: StandaloneServerOptions): Promise<Server> {
  const { config, managementHandler, managementReady, staticRoot, password, sessionTtlMs, now } = options
  const secure = new URL(config.publicOrigin).protocol === 'https:'
  const cookieScope = JSON.stringify([resolve(config.stateDir), config.port])
  const auth = createAuth({ password, secure, cookieScope, sessionTtlMs, now })
  let root: string
  try {
    root = await realpath(staticRoot)
    if (!(await stat(root)).isDirectory()) throw new Error()
  } catch { throw new Error('Standalone static root is unavailable') }

  const server = createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('referrer-policy', 'same-origin')
    res.setHeader('content-security-policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self' 'unsafe-inline'")
    void (async () => {
      if (!sameSite(req, config)) { json(res, 403, { error: 'Request origin is not allowed' }); return }
      const path = pathOf(req)
      if (!path) { json(res, 404, { error: 'Not found' }); return }
      const method = req.method ?? 'GET'
      if ((path === '/login' || path === '/logout') && method === 'POST' && req.headers.origin === undefined
        && req.headers['sec-fetch-site'] !== 'same-origin') {
        json(res, 403, { error: 'Request origin is not allowed' }); return
      }
      if (path === '/healthz' && method === 'GET') { json(res, 200, { ok: true }); return }
      if (path === '/login' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(LOGIN_PAGE); return
      }
      if (path === '/login' && method === 'POST') {
        let body: string
        try { body = await readBody(req) } catch (error) {
          json(res, error instanceof BodyTooLarge ? 413 : 400, { error: 'Invalid request' }); return
        }
        const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
        const candidate = passwordFrom(body, contentType)
        const token = auth.login(candidate ?? '')
        if (!token) { json(res, 401, { error: 'Invalid credentials' }); return }
        auth.logout(req.headers.cookie)
        res.setHeader('set-cookie', auth.sessionCookie(token))
        if (contentType === 'application/json') json(res, 200, { ok: true })
        else { res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); res.end() }
        return
      }
      if (path === '/logout' && method === 'POST') {
        auth.logout(req.headers.cookie)
        res.setHeader('set-cookie', auth.expiredCookie())
        res.writeHead(303, { location: '/login', 'cache-control': 'no-store' }); res.end(); return
      }
      const api = path === '/orchestrator/api' || path.startsWith('/orchestrator/api/')
      if (api && managementReady && !managementReady()) {
        json(res, 503, { error: 'Application is not ready' }); return
      }
      if (!auth.authenticated(req.headers.cookie)) {
        if (api || path.startsWith('/assets/')) json(res, 401, { error: 'Authentication required' })
        else if ((path === '/' || path === '/index.html') && (method === 'GET' || method === 'HEAD')) {
          res.writeHead(303, { location: '/login', 'cache-control': 'no-store' }); res.end()
        } else json(res, 404, { error: 'Not found' })
        return
      }
      if (api) {
        if (!oneHeader(req, 'x-orchestrator-request') || req.headers['x-orchestrator-request'] !== '1') {
          json(res, 403, { error: 'Management request header required' }); return
        }
        res.setHeader('cache-control', 'no-store')
        if (!await managementHandler(req, res) && !res.headersSent) json(res, 404, { error: 'Not found' })
        return
      }
      if ((method === 'GET' || method === 'HEAD') && await staticFile(root, path, req, res)) return
      json(res, 404, { error: 'Not found' })
    })().catch(() => {
      if (res.headersSent) res.destroy()
      else json(res, 500, { error: 'Internal server error' })
    })
  })
  return server
}
