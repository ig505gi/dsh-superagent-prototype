/** Cancellation regressions run inside a separate process group so a regression cannot signal the test runner. */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { trashSync } from './fixtures/trash.ts'

it('never signals failed/unstarted handles, cancels a running child, and clears the delayed force timer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-process-cancel-')), script = join(root, 'probe.mjs')
  const module = new URL('../src/runtime/process.ts', import.meta.url).href
  writeFileSync(script, `import {LocalProcesses} from ${JSON.stringify(module)};
let unexpectedSigterm=0;process.on('SIGTERM',()=>{unexpectedSigterm++});
const transport=new LocalProcesses(),pre=new AbortController();pre.abort();let preRejected=false;
try{transport.spawn({argv:['/owned-missing-cli'],signal:pre.signal});}catch(e){preRejected=e.name==='AbortError';}
const pending=new AbortController();const failed=transport.spawn({argv:['/owned-missing-cli'],signal:pending.signal});pending.abort();
let failedSpawn=false;try{await failed.done;}catch{failedSpawn=true;}
await new Promise(r=>setTimeout(r,2300));
const live=new AbortController(),job=transport.spawn({argv:[process.execPath,'-e','console.log("spawned");setTimeout(()=>{},30000)'],signal:live.signal});
for(let i=0;i<100&&!job.collected.stdout.readFrom(0).text.includes('spawned');i++)await new Promise(r=>setTimeout(r,10));
live.abort();const end=await job.done;await new Promise(r=>setTimeout(r,2300));
console.log(JSON.stringify({preRejected,failedSpawn,unexpectedSigterm,liveSignal:end.signal,survivedForceDeadline:true}));
`)
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
  const timer = setTimeout(() => { if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 9000)
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => { resolve({ code, signal }) })
    })
    expect(result, stderr).toEqual({ code: 0, signal: null })
    expect(JSON.parse(stdout.trim())).toEqual({ preRejected: true, failedSpawn: true, unexpectedSigterm: 0, liveSignal: 'SIGTERM', survivedForceDeadline: true })
  } finally { clearTimeout(timer); trashSync(root, { recursive: true, force: true }) }
}, 12000)
