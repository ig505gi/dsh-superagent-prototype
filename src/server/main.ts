#!/usr/bin/env node
/** Explicit configuration-file CLI for the standalone Superagent service. */
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { startApplication } from './application.ts'

try {
  const args = parseArgs({ options: { config: { type: 'string' } }, strict: true, allowPositionals: false })
  if (!args.values.config) throw new Error('An explicit configuration file is required')
  const input: unknown = JSON.parse(await readFile(args.values.config, 'utf8'))
  const application = await startApplication(input)
  const stop = () => { void application.stop().catch(() => { process.exitCode = 1 }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  console.info(`Superagent is listening on ${application.config.host}:${application.config.port}`)
} catch {
  console.error('Superagent could not start. Check the configuration, credentials, exclusive state directory, and Paseo connectivity.')
  process.exitCode = 1
}
