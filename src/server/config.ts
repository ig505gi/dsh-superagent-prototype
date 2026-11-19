import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { LIMITS } from '../limits.ts'

const absolutePath = z.string().min(1).refine(value => isAbsolute(value) && !value.includes('\0'))
const role = z.object({
  profileId: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  modeId: z.string().trim().min(1).max(100).optional(),
  thinkingOptionId: z.string().trim().min(1).max(100).optional(),
  cwd: absolutePath.optional(),
  workspaceId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
}).strict()

function isPrivateAddress(host: string): boolean {
  const family = isIP(host)
  if (family === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 127 || a === 10 || (a === 100 && b !== undefined && b >= 64 && b <= 127)
      || (a === 172 && b !== undefined && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (family === 6) {
    try {
      const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1)
      const first = Number.parseInt(normalized.split(':')[0] || '0', 16)
      return normalized === '::1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
    } catch { return false }
  }
  return false
}

const schema = z.object({
  stateDir: absolutePath,
  instanceId: z.string().trim().min(1).max(64).optional(),
  host: z.string().refine(isPrivateAddress).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3083),
  publicOrigin: z.string().optional(),
  allowedHosts: z.array(z.string()).min(1).max(32).optional(),
  paseo: z.object({
    endpoint: z.string().min(1).max(2048).default('127.0.0.1:6767'),
    piAgentDir: z.unknown().optional(),
    main: role.transform(({ profileId, cwd }): { profileId?: string; cwd?: string } => ({
      ...(profileId ? { profileId } : {}), ...(cwd ? { cwd } : {}),
    })).default({}),
    worker: role.transform(({ profileId }): { profileId?: string } => profileId ? { profileId } : {}).default({}),
  }).strict().transform(({ piAgentDir: _legacy, ...settings }) => settings)
    .default({ endpoint: '127.0.0.1:6767', main: {}, worker: {} }),
  promptMaxChars: z.number().int().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).default(100_000),
  admissionContextMaxPages: z.number().int().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).default(10),
  admissionContextTimeoutMs: z.number().int().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).default(15_000),
}).strict()

function validHostname(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (isIP(host)) return true
  return host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

/** Normalize a Host header or configured authority without accepting userinfo, paths, or malformed ports. */
export function normalizeAuthority(authority: string, protocol: 'http:' | 'https:'): string | undefined {
  if (!authority || authority.endsWith(':') || /[\s\\/@?#]/.test(authority)) return
  try {
    const url = new URL(`${protocol}//${authority}`)
    if (!validHostname(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return
    if (url.port && Number(url.port) === 0) return
    return url.host.toLowerCase()
  } catch { return }
}

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value)
    const authority = /^https?:\/\/([^/?#]+)\/?$/i.exec(value)?.[1]
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
      || !authority || url.pathname !== '/' || url.search || url.hash || !normalizeAuthority(authority, url.protocol)) return
    return url.origin
  } catch { return }
}

function validEndpoint(value: string): boolean {
  try {
    const hasScheme = value.includes('://')
    if (!hasScheme && !/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d{1,5}$/i.test(value)) return false
    const url = new URL(hasScheme ? value : `ws://${value}`)
    const authority = hasScheme ? /^wss?:\/\/([^/?#]+)(?:\/ws|\/)?$/i.exec(value)?.[1] : value
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password
      || !authority || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '/ws')) return false
    return !!normalizeAuthority(authority, url.protocol === 'wss:' ? 'https:' : 'http:')
  } catch { return false }
}

type ParsedConfig = z.output<typeof schema>
export type StandaloneConfig = Omit<ParsedConfig, 'publicOrigin' | 'allowedHosts'> & {
  publicOrigin: string
  allowedHosts: string[]
}

/** Parse non-secret configuration. Invalid input is deliberately not echoed in the error. */
export function loadConfig(input: unknown): StandaloneConfig {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error('Invalid standalone configuration')
  const config = parsed.data
  const bindHost = isIP(config.host) === 6 ? `[${config.host}]` : config.host
  const publicOrigin = originOf(config.publicOrigin ?? `http://${bindHost}:${config.port}`)
  if (!publicOrigin || !validEndpoint(config.paseo.endpoint)) throw new Error('Invalid standalone configuration')
  const origin = new URL(publicOrigin), protocol = origin.protocol as 'http:' | 'https:'
  const defaults = [origin.host, ...(config.host === '127.0.0.1' && !config.publicOrigin ? [`localhost:${config.port}`] : [])]
  const hosts = (config.allowedHosts ?? defaults).map(host => normalizeAuthority(host, protocol))
  if (hosts.some(host => !host) || !hosts.includes(origin.host)) throw new Error('Invalid standalone configuration')
  return { ...config, publicOrigin, allowedHosts: [...new Set(hosts as string[])] }
}

/** Configuration contains no credentials; return a detached copy for a management view. */
export function configView(config: StandaloneConfig): StandaloneConfig {
  return structuredClone(config)
}
