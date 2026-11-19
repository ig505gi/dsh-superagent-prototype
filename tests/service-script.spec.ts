/** Exercises the standalone controller with an actual isolated Node process, authentication and process identities. */
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { trashSync } from './fixtures/trash.ts'
let root: string, config: string, state: string, url: string, password: string
const pids = new Set<number>()
const states = new Set<string>()
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  return address.port
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'standalone service ')); state = join(root, 'state'); password = randomUUID()
  states.add(state)
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'lib/server'), { recursive: true }); mkdirSync(state)
  copyFileSync(new URL('../scripts/superagent', import.meta.url), join(root, 'scripts/superagent'))
  const port = await freePort()
  url = `http://127.0.0.1:${port}`; config = join(root, 'config with spaces.json')
  writeFileSync(config, JSON.stringify({ stateDir: state, host: '127.0.0.1', port, publicOrigin: url }))
  writeFileSync(join(root, 'reply.json'), JSON.stringify({ health: { runtime: { state: 'ready' } }, setup: { problem: null } }))
  writeFileSync(join(root, 'lib/server/main.js'), `const http=require('http'),fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[3]));
const ready=Date.now()+(c.startupDelayMs??0);
const server=http.createServer((req,res)=>{if(req.url==='/healthz'){res.end('{}');return}
if(req.url==='/login'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{if(JSON.parse(body).password!==process.env.SUPERAGENT_PASSWORD){res.writeHead(401).end();return}res.setHeader('set-cookie','session=test; Path=/');res.end('{}')});return}
if(Date.now()<ready){res.writeHead(503).end();return}
if(req.headers.cookie!=='session=test'){res.writeHead(401).end();return}res.end(fs.readFileSync(${JSON.stringify(join(root, 'reply.json'))}));});
server.listen(c.port,c.host);process.on('SIGTERM',()=>server.close(()=>process.exit()));`)
})
afterEach(async () => {
  for (const directory of states) {
    try { const record = JSON.parse(readFileSync(join(directory, 'control/process.json'), 'utf8')); if (record.pid) pids.add(record.pid) } catch {}
  }
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  states.clear(); pids.clear(); trashSync(root, { recursive: true, force: true })
})
const runFrom = (checkout: string, file: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => {
  execFile('python3', [join(checkout, 'scripts/superagent'), ...args, '--config', file], { env: { ...process.env, SUPERAGENT_PASSWORD: password, SUPERAGENT_PASSWORD_FILE: '' }, timeout: 12_000 },
    (error, out, err) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, out, err }))
})
const run = (...args: string[]) => runFrom(root, config, ...args)
const status = async () => { const result = await run('status'); return { ...result, data: JSON.parse(result.out) } }
it('starts the Node entry from paths with spaces, authenticates health, records birth identity and refuses duplicates', async () => {
  expect(await run('start', '--timeout', '5')).toMatchObject({ code: 0 })
  const first = await status(); expect(first.data.pids).toHaveLength(1); expect(first.data.reachable).toBe(true)
  const record = JSON.parse(readFileSync(join(state, 'control/process.json'), 'utf8'))
  expect(record.identity).toBeTypeOf('string'); expect(record.identity).toContain('lib/server/main.js')
  expect(await run('start', '--timeout', '5')).toMatchObject({ code: 0 })
  expect((await status()).data.pids).toEqual(first.data.pids)
  expect(await run('stop', '--stop-timeout', '3')).toMatchObject({ code: 0 })
}, 15_000)
it('persists intentional stop per state and skips automatic recovery', async () => {
  expect(await run('stop')).toMatchObject({ code: 0 })
  expect((await status()).data.manually_stopped).toBe(true)
  expect(await run('start', '--respect-stop')).toMatchObject({ code: 0, out: expect.stringContaining('Intentional stop') })
  expect((await status()).data.pids).toEqual([])
})
it('waits for management readiness when the listener binds before startup finishes', async () => {
  const settings = JSON.parse(readFileSync(config, 'utf8'))
  writeFileSync(config, JSON.stringify({ ...settings, startupDelayMs: 700 }))
  expect(await run('start', '--timeout', '5')).toMatchObject({ code: 0, out: expect.stringContaining('"reachable": true') })
}, 10_000)
it('controls two instances independently and finds the recorded process from a rebuilt checkout', async () => {
  const next = join(root, 'next checkout'), configB = join(root, 'project-b.json'), stateB = join(root, 'state-b')
  states.add(stateB)
  expect(await run('start', '--timeout', '5')).toMatchObject({ code: 0 })
  const port = await freePort()
  writeFileSync(configB, JSON.stringify({ stateDir: stateB, port }))
  const runB = (...args: string[]) => runFrom(root, configB, ...args)
  expect(await runB('start', '--timeout', '5')).toMatchObject({ code: 0 })
  const [pidA] = (await status()).data.pids
  const [pidB] = JSON.parse((await runB('status')).out).pids
  expect(pidA).not.toBe(pidB)
  for (const file of ['scripts/superagent', 'lib/server/main.js']) {
    mkdirSync(join(next, file, '..'), { recursive: true })
    copyFileSync(join(root, file), join(next, file))
  }
  const rebuilt = (...args: string[]) => runFrom(next, config, ...args)
  expect(await rebuilt('status')).toMatchObject({ code: 0 })
  expect(await rebuilt('start', '--timeout', '5')).toMatchObject({ code: 0 })
  expect(JSON.parse((await rebuilt('status')).out).pids).toEqual([pidA])
  expect(await rebuilt('stop', '--stop-timeout', '3')).toMatchObject({ code: 0 })
  expect((await status()).data).toMatchObject({ pids: [], manually_stopped: true })
  expect(JSON.parse((await runB('status')).out)).toMatchObject({ pids: [pidB], manually_stopped: false, reachable: true })
  expect(await runB('stop', '--stop-timeout', '3')).toMatchObject({ code: 0 })
}, 15_000)
it('restarts only its own process and reports missing setup and component errors distinctly', async () => {
  await run('start', '--timeout', '5'); const before = (await status()).data.pids[0]
  expect(await run('restart', '--timeout', '5', '--stop-timeout', '3')).toMatchObject({ code: 0 })
  expect((await status()).data.pids[0]).not.toBe(before)
  writeFileSync(join(root, 'reply.json'), JSON.stringify({ health: { runtime: { state: 'paused' } }, setup: { problem: { code: 'repositoryUnset' } } }))
  expect((await status()).code).toBe(3)
  writeFileSync(join(root, 'reply.json'), JSON.stringify({ health: { runtime: { state: 'ready' }, github: { state: 'error', detail: 'CLI unavailable' } } }))
  expect((await status()).code).toBe(2)
  writeFileSync(join(root, 'reply.json'), JSON.stringify({ health: { runtime: { state: 'error' } } }))
  expect((await status()).code).toBe(1)
}, 15_000)
it('does not trust a reused PID and never prints secrets on failure', async () => {
  await run('start', '--timeout', '5')
  const record = JSON.parse(readFileSync(join(state, 'control/process.json'), 'utf8')); pids.add(record.pid)
  writeFileSync(join(state, 'control/process.json'), JSON.stringify({ ...record, identity: 'an earlier unrelated process' }))
  const stopped = await run('stop'); expect(stopped.code).toBe(1)
  expect(stopped.err).not.toContain(password); expect(() => process.kill(record.pid, 0)).not.toThrow()
})
it('refuses a different service already listening at its configured URL', async () => {
  const host = createServer((_req, res) => { res.end('{}') }); const port = Number(new URL(url).port)
  await new Promise<void>(resolve => { host.listen(port, '127.0.0.1', resolve) })
  try { expect((await run('start', '--timeout', '1')).code).toBe(1); expect((await status()).data.pids).toEqual([]) }
  finally { await new Promise<void>(resolve => { host.close(() => { resolve() }) }) }
})
