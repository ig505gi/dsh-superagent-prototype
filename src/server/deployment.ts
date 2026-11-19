import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { DeploymentLimitField, DeploymentOp, DeploymentView } from '../app/api.ts'
import type { Machine } from '../deployment.ts'
import { LIMITS } from '../limits.ts'
import type { StandaloneConfig } from './config.ts'

const fields = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
const field = z.enum(fields)
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const limit = (name: DeploymentLimitField) => z.number().int().min(LIMITS[name].min).max(LIMITS[name].max)
const overridesSchema = z.object({
  promptMaxChars: limit('promptMaxChars').optional(),
  admissionContextMaxPages: limit('admissionContextMaxPages').optional(),
  admissionContextTimeoutMs: limit('admissionContextTimeoutMs').optional(),
}).strict()
const persistedSchema = z.object({ revision, overrides: overridesSchema }).strict()
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.tuple([field]), value: z.number().int() }).strict(),
  z.object({ op: z.literal('unset'), path: z.tuple([field]) }).strict(),
]).superRefine((op, ctx) => {
  if (op.op === 'set' && !limit(op.path[0]).safeParse(op.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'Value is outside the allowed range' })
  }
})
export const DeploymentWriteSchema = z.object({ revision, ops: z.array(operation).min(1).max(fields.length) }).strict()
  .superRefine(({ ops }, ctx) => {
    const seen = new Set<DeploymentLimitField>()
    ops.forEach((op, index) => {
      if (seen.has(op.path[0])) ctx.addIssue({ code: 'custom', path: ['ops', index, 'path'], message: 'Duplicate limit' })
      seen.add(op.path[0])
    })
  })

/** Signals a concurrent settings edit without exposing configuration values. */
export class DeploymentConflict extends Error {
  constructor() { super('Deployment settings changed. Reload before saving.') }
}
/** Signals that the current instance cannot persist deployment settings. */
export class DeploymentReadOnly extends Error {
  constructor() { super('Deployment settings are read-only') }
}

type Persisted = z.output<typeof persistedSchema>
const queues = new Map<string, Promise<void>>()
const MAX_FILE_BYTES = 64 * 1024

function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve()
  const result = previous.then(work)
  const tail = result.then(() => undefined, () => undefined)
  queues.set(path, tail)
  void tail.then(() => { if (queues.get(path) === tail) queues.delete(path) })
  return result
}

async function readStored(path: string): Promise<Persisted> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, overrides: {} }
    throw new Error('Unable to read deployment settings')
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error()
    const value: unknown = JSON.parse(await handle.readFile('utf8'))
    const result = persistedSchema.safeParse(value)
    if (!result.success) throw new Error()
    return result.data
  } catch { throw new Error('Invalid or unreadable deployment settings') }
  finally { await handle.close() }
}

/** One instance per locked Runtime; in-process writes to the same canonical directory are serialized. */
export class DeploymentSettings {
  readonly machine: Machine
  private constructor(
    private readonly config: StandaloneConfig,
    private readonly file: string,
    private readonly writable: boolean,
    private current: Persisted,
  ) {
    this.machine = {
      stateDir: config.stateDir,
      promptMaxChars: { get: () => this.value('promptMaxChars') },
      admissionContextMaxPages: { get: () => this.value('admissionContextMaxPages') },
      admissionContextTimeoutMs: { get: () => this.value('admissionContextTimeoutMs') },
    }
  }

  /** The caller must hold the application's stateDir lock before opening this store. */
  static async open(config: StandaloneConfig, options: { writable?: boolean } = {}): Promise<DeploymentSettings> {
    try {
      await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
      const file = join(await realpath(config.stateDir), 'machine-settings.json')
      const current = await readStored(file)
      return new DeploymentSettings(config, file, options.writable ?? true, current)
    } catch { throw new Error('Unable to open deployment settings') }
  }

  private value(name: DeploymentLimitField): number { return this.current.overrides[name] ?? this.config[name] }
  read(): DeploymentView {
    const { stateDir, instanceId, host, port, paseo } = this.config
    return { revision: this.current.revision, writable: this.writable, value: { stateDir,
      instanceId: instanceId ?? null, listen: { host, port }, paseoEndpoint: paseo.endpoint,
      promptMaxChars: this.value('promptMaxChars'), admissionContextMaxPages: this.value('admissionContextMaxPages'),
      admissionContextTimeoutMs: this.value('admissionContextTimeoutMs') } }
  }

  async write(ops: DeploymentOp[], expectedRevision: number): Promise<DeploymentView> {
    const input = DeploymentWriteSchema.parse({ ops, revision: expectedRevision })
    return serialized(this.file, async () => {
      if (!this.writable) throw new DeploymentReadOnly()
      const stored = await readStored(this.file)
      if (input.revision !== this.current.revision || input.revision !== stored.revision) throw new DeploymentConflict()
      if (stored.revision === Number.MAX_SAFE_INTEGER) throw new Error('Deployment settings revision limit reached')
      const overrides = { ...stored.overrides }
      for (const op of input.ops) {
        if (op.op === 'set') overrides[op.path[0]] = op.value
        else delete overrides[op.path[0]]
      }
      const next: Persisted = { revision: stored.revision + 1, overrides }
      const temp = join(dirname(this.file), `.machine-settings.${randomBytes(16).toString('hex')}.tmp`)
      try {
        const handle = await open(temp, 'wx', 0o600)
        try { await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8'); await handle.sync() }
        finally { await handle.close() }
        await rename(temp, this.file)
      } catch { throw new Error('Unable to save deployment settings') }
      this.current = next
      return this.read()
    })
  }
}
