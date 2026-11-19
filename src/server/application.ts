/** Standalone application composition: one state lease, shared machine limits, Paseo execution, and authenticated HTTP. */
import type { Server } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Runtime } from '../app/runtime.ts'
import { createManagementHandler } from '../app/http.ts'
import { PaseoRuntime, type PaseoOptions } from '../runtime/paseo.ts'
import { acquireStateLock } from '../runtime/lock.ts'
import { loadConfig, type StandaloneConfig } from './config.ts'
import { loadPassword } from './auth.ts'
import { DeploymentSettings } from './deployment.ts'
import { createStandaloneServer } from './http.ts'
import { apply as github } from '../sources/github.ts'
import { apply as gitlab } from '../sources/gitlab.ts'
import { apply as feishu } from '../sources/feishu.ts'
import { apply as dingtalk } from '../sources/dingtalk.ts'
import { apply as paseo } from '../sources/paseo.ts'

export interface StandaloneApplication {
  readonly config: StandaloneConfig
  readonly server: Server
  readonly runtime: Runtime
  readonly adapter: PaseoRuntime
  stop(): Promise<void>
}
export interface ApplicationOptions { password?: string; staticRoot?: string; paseo?: PaseoOptions; listen?: boolean }
async function paseoPassword(): Promise<string | undefined> {
  const inline = process.env.PASEO_PASSWORD, file = process.env.PASEO_PASSWORD_FILE
  if (inline !== undefined && file !== undefined) throw new Error('Configure only one Paseo password source')
  if (file === undefined) {
    if (inline !== undefined && (!inline || Buffer.byteLength(inline) > 1024)) throw new Error('Invalid Paseo password source')
    return inline
  }
  if (!file.startsWith('/')) throw new Error('Paseo password file must be absolute')
  try { const value = (await readFile(file, 'utf8')).replace(/\r?\n$/, ''); if (!value || value.length > 1024) throw new Error(); return value }
  catch { throw new Error('Cannot read Paseo password file') }
}
/** Start a fresh-state application while retaining existing Paseo IDs on subsequent starts of that same state directory. */
export async function startApplication(input: unknown, options: ApplicationOptions = {}): Promise<StandaloneApplication> {
  const config = loadConfig(input)
  let stopping: Promise<void> | undefined, restarting: Promise<void> | undefined
  let server: Server | undefined, adapter: PaseoRuntime | undefined, runtime: Runtime | undefined
  let currentHandler: ReturnType<typeof createManagementHandler> | undefined
  let unmount: (() => Promise<void>) | undefined
  const lease = acquireStateLock(config.stateDir, () => {
    void stop().catch(() => { console.error('Superagent could not stop cleanly.') })
  })
  const mount = async (deploymentSettings: DeploymentSettings) => {
    if (stopping) return
    const password = await paseoPassword()
    if (stopping) return
    const nextAdapter = adapter = new PaseoRuntime(config, { password, ...options.paseo })
    let nextRuntime: Runtime | undefined
    let unmounting: Promise<void> | undefined
    unmount = () => unmounting ??= (async () => {
      // Source registration can fail before mount awaits runtime initialization.
      await nextRuntime?.ready.catch(() => {})
      try {
        await nextAdapter.context.dispose()
      } finally {
        try { await nextRuntime?.stop() }
        finally { await nextAdapter.close() }
      }
    })()
    await nextAdapter.ready
    if (stopping) return
    nextRuntime = runtime = new Runtime(nextAdapter.context, deploymentSettings.machine, () => { restart(deploymentSettings) }, { stateLease: lease })
    const handler = createManagementHandler(nextRuntime.httpHost(), { deploymentSettings, sessionLink: id => nextAdapter.link(id) })
    for (const source of [github, gitlab, feishu, dingtalk, paseo]) source(nextAdapter.context)
    currentHandler = handler
    await nextRuntime.ready
  }
  const restart = (deploymentSettings: DeploymentSettings) => {
    if (restarting || stopping) return
    currentHandler = undefined
    restarting = starting.then(async () => {
      await unmount?.()
      await mount(deploymentSettings)
    }).catch(() => {
      currentHandler = undefined
      console.error('Superagent could not restart; check setup and Paseo connectivity.')
    }).finally(() => { restarting = undefined })
  }
  function stop(): Promise<void> {
    return stopping ??= Promise.resolve().then(async () => {
      // A compromised lease can request stop before startup has bound the listener.
      await starting.catch(() => {})
      const listener = server
      if (listener?.listening) await new Promise<void>(resolveClose => {
        listener.close(() => resolveClose())
        listener.closeAllConnections()
      })
      await restarting
      await unmount?.()
      lease.release()
    })
  }
  const starting = (async (): Promise<StandaloneApplication> => {
    const deploymentSettings = await DeploymentSettings.open(config)
    const password = options.password ?? await loadPassword()
    const staticRoot = options.staticRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')
    const listener = server = await createStandaloneServer({ config, password, staticRoot,
      managementReady: () => !stopping && currentHandler !== undefined,
      managementHandler: (request, response) => currentHandler!(request, response),
    })
    if (!stopping && options.listen !== false) await new Promise<void>((resolveListen, reject) => {
      listener.once('error', reject)
      listener.listen(config.port, config.host, () => { listener.off('error', reject); resolveListen() })
    })
    await mount(deploymentSettings)
    if (stopping) throw new Error('Application stopped during startup')
    return { config, server: listener,
      get runtime() { return runtime! }, get adapter() { return adapter! }, stop }
  })()
  try {
    return await starting
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
}
