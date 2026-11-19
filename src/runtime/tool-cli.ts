/** Shell entry point for the capability-bound Superagent tool gateway. */
import { readFile } from 'node:fs/promises'

const usage = "Usage: superagent-tool list | superagent-tool call <tool_name> '<json>' | superagent-tool call <tool_name> --stdin"

async function stdin(): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 2_000_000) throw new Error('Tool arguments exceed the input limit')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function run(): Promise<void> {
  const [command, name, input, ...rest] = process.argv.slice(2)
  if (command === '--help' && !name) { console.log(usage); return }
  const listing = command === 'list' && name === undefined
  const calling = command === 'call' && !!name && input !== undefined && !rest.length
  if (!listing && !calling) throw new Error(usage)
  let args: unknown
  if (calling) {
    const json = input === '--stdin' ? await stdin() : input
    try { args = JSON.parse(json) }
    catch { throw new Error('Tool arguments must be valid JSON') }
  }
  const file = process.env.SUPERAGENT_CONTROL_FILE
  if (!file) throw new Error('SUPERAGENT_CONTROL_FILE is missing from this session')
  let endpoint: URL, capability: string
  try {
    const control = JSON.parse(await readFile(file, 'utf8')) as { endpoint: string; capability: string }
    endpoint = new URL(control.endpoint)
    capability = control.capability
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
      || typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability)) throw new Error()
  } catch { throw new Error('The session control file is unreadable or invalid') }
  const response = await fetch(new URL(listing ? '/tools' : '/tool', endpoint), {
    method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + capability, 'content-type': 'application/json' },
    body: JSON.stringify(listing ? {} : { name, args }),
  }).catch(() => { throw new Error('Could not reach the local Superagent tool gateway') })
  const result = await response.json() as { error?: string; isError?: boolean; content?: { text?: string }[] }
  if (!response.ok) throw new Error(result.error ?? 'The Superagent gateway refused the request (HTTP ' + response.status + ')')
  console.log(JSON.stringify(result, null, 2))
  if (result.isError) throw new Error(result.content?.find(part => part.text)?.text ?? 'Superagent tool failed')
}

void run().catch(error => {
  console.error(error instanceof Error ? error.message : 'Superagent tool failed')
  process.exitCode = 1
})
