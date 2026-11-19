/** Controlled shell, jobs, delegation, skills, images, and web tools exposed beside the unchanged business schemas. */
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { z } from 'zod'
import type { PaseoRuntime } from './paseo.ts'
import type { Binding } from './state.ts'
import { bundledSkills } from '../app/skill-files.ts'
import { withToolAuthority } from './authority.ts'

const schemas = {
  superagent_shell: z.object({ command: z.string().min(1), description: z.string().optional(), timeoutMs: z.number().int().min(0).optional(), run_in_background: z.boolean().optional() }).strict(),
  superagent_powershell: z.object({ command: z.string().min(1), description: z.string().optional(), timeoutMs: z.number().int().min(0).optional(), run_in_background: z.boolean().optional() }).strict(),
  superagent_job_output: z.object({ job_id: z.string(), wait: z.boolean().default(false), timeout_ms: z.number().int().min(0).max(600_000).default(5000) }).strict(),
  superagent_job_list: z.object({}).strict(),
  superagent_job_kill: z.object({ job_id: z.string() }).strict(),
  superagent_skill: z.object({ name: z.string().min(1) }).strict(),
  superagent_image: z.object({ path: z.string().min(1) }).strict(),
  superagent_web_search: z.object({ query: z.string().trim().min(1).max(2000) }).strict(),
  superagent_web_fetch: z.object({ url: z.url(), max_chars: z.number().int().min(1).max(50_000).default(16000) }).strict(),
  superagent_todo: z.object({ todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }).strict()).max(100) }).strict(),
  superagent_subagent: z.object({ prompt: z.string().min(1), name: z.string().max(100).optional(), profileId: z.string().min(1).optional() }).strict(),
  superagent_subagent_models: z.object({}).strict(),
  superagent_agent_message: z.object({ agent_id: z.string(), message: z.string().min(1) }).strict(),
  superagent_agents: z.object({}).strict(),
  superagent_interrupt: z.object({ agent_id: z.string() }).strict(),
}
type ControlName = keyof typeof schemas
const descriptions: Record<ControlName, string> = {
  superagent_shell: 'Run a shell command in this session workspace. After at most 5 seconds the registered job continues in the background; its end arrives automatically. Main must not sleep, wait, or request more than 30 seconds.',
  superagent_powershell: 'Run PowerShell through a registered shell job. Available to workers, under the same job ownership and lifecycle.',
  superagent_job_output: 'Read only a shell job this session owns; optionally wait for its end. Main may wait at most 5 seconds.',
  superagent_job_list: 'List the registered shell jobs this session owns.', superagent_job_kill: 'Stop a registered shell job this session owns, checking its process identity.',
  superagent_skill: 'Read the current application skill by its registered name, such as dsh-superagent-github.',
  superagent_image: 'Read a PNG/JPEG/WebP/GIF image as model-visible image content.',
  superagent_web_search: 'Search the public web for a query and return result links; use web_fetch to read a result.',
  superagent_web_fetch: 'Read a public HTTP or HTTPS page as bounded text.', superagent_todo: 'Save this session task list.',
  superagent_subagent: 'Delegate a task to a child managed and visible in Paseo. It inherits this ticket and assignment limits. The result arrives automatically; end your turn instead of waiting.',
  superagent_subagent_models: 'List Paseo Agent Profiles and their availability for a managed child.',
  superagent_agent_message: 'Send a follow-up to one of this session descendants. Other conversations are inaccessible.',
  superagent_agents: 'List this session descendants, with their state and Paseo agent IDs.',
  superagent_interrupt: 'Stop this session child and its owned work; other conversations are inaccessible.',
}
const mainControls: readonly ControlName[] = ['superagent_shell', 'superagent_image', 'superagent_job_output', 'superagent_job_list',
  'superagent_job_kill', 'superagent_skill']
export function controlToolNames(role: Binding['role']): readonly ControlName[] {
  return role === 'orchestrator' ? mainControls : Object.keys(schemas) as ControlName[]
}
export function managedToolDefinitions(runtime: PaseoRuntime, binding: Binding) {
  const tools = runtime.agent(binding.id).tools
  const controls = controlToolNames(binding.role)
    .filter(name => tools.allows(name))
    .map(name => ({ name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name]) }))
  const business = [...tools.local.values()].filter(tool => tools.allows(tool.name))
    .map(tool => ({ name: tool.name, description: tool.description ?? tool.name, parameters: tool.parameters ?? {} }))
  return [...business, ...controls]
}
function plain(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}
async function page(url: string, signal: AbortSignal): Promise<string> {
  const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Choose an HTTP or HTTPS URL without credentials')
  const response = await fetch(parsed, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { 'user-agent': 'Superagent/1.0' } })
  if (!response.ok) throw new Error(`Web request returned HTTP ${response.status}`)
  const reader = response.body?.getReader(); if (!reader) return ''
  const chunks: Uint8Array[] = []; let bytes = 0
  try { for (;;) { const row = await reader.read(); if (row.done) break; bytes += row.value.length; if (bytes > 2_000_000) throw new Error('Web page exceeds the read limit'); chunks.push(row.value) } }
  finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks).toString('utf8')
}

/** Invoke only the selected bound tool; caller-supplied role, ticket, or labels never select authorization. */
export async function executeManagedTool(runtime: PaseoRuntime, binding: Binding, name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  const key = name as ControlName
  if (!Object.hasOwn(schemas, name)) {
    const business = runtime.agent(binding.id).tools.local.get(name)
    if (!business) throw new Error('Unknown application tool')
    const refusal = await runtime.authorize(binding, name, input)
    if (refusal) throw new Error(refusal)
    runtime.assertBinding(binding)
    return withToolAuthority(() => { signal.throwIfAborted(); runtime.assertBinding(binding) }, () => business.execute(input, { signal }))
  }
  // Validate CLI input before dispatch and recheck ownership after asynchronous authorization.
  const args = schemas[key].parse(input)
  const refusal = await runtime.authorize(binding, name, args); if (refusal) throw new Error(refusal)
  runtime.assertBinding(binding)
  signal.throwIfAborted()
  switch (key) {
    case 'superagent_shell': case 'superagent_powershell': {
      const value = args as z.infer<typeof schemas.superagent_shell>
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
      return runtime.jobs.start(binding, key === 'superagent_powershell' ? `pwsh -NoProfile -Command ${quote(value.command)}` : value.command,
        runtime.commandEnvironment(binding), value.timeoutMs, value.run_in_background, signal)
    }
    case 'superagent_job_list': return { jobs: runtime.jobs.list(binding.id).map(({ stdout: _out, stderr: _err, nonce: _nonce, processIdentity: _identity, ...job }) => job) }
    case 'superagent_job_output': {
      const value = args as z.infer<typeof schemas.superagent_job_output>
      if (value.wait) await runtime.jobs.wait(value.job_id, value.timeout_ms, binding.id, signal)
      return runtime.jobs.read(value.job_id, binding.id)
    }
    case 'superagent_job_kill': { const value = args as z.infer<typeof schemas.superagent_job_kill>; runtime.jobs.kill(value.job_id, binding.id); return { requested: true } }
    case 'superagent_skill': {
      const value = args as z.infer<typeof schemas.superagent_skill>, version = runtime.host.prompts.current()
      const name = value.name.replace(/^dsh-superagent-/, ''), content = runtime.host.prompts.skills(version.config).find(([key]) => key === name)?.[1]
      if (!content) throw new Error('Unknown application skill')
      const bundled = name === 'github' || name === 'gitlab' || name === 'feishu' ? bundledSkills[name] : undefined
      return { name: value.name, content, ...(bundled ? { resource_file: bundled.path } : {}) }
    }
    case 'superagent_image': {
      const value = args as z.infer<typeof schemas.superagent_image>, path = resolve(binding.cwd, value.path), file = await stat(path)
      if (!file.isFile() || file.size > 10_000_000) throw new Error('Image is not a regular file within the byte limit')
      const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
      const mediaType = mime[extname(path).toLowerCase()]; if (!mediaType) throw new Error('Unsupported image format')
      return { path, media_type: mediaType, bytes: file.size, imageContent: { type: 'image', mimeType: mediaType, data: (await readFile(path, { signal })).toString('base64') } }
    }
    case 'superagent_web_fetch': { const value = args as z.infer<typeof schemas.superagent_web_fetch>; return { url: value.url, text: plain(await page(value.url, signal)).slice(0, value.max_chars) } }
    case 'superagent_web_search': {
      const value = args as z.infer<typeof schemas.superagent_web_search>, html = await page(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(value.query)}`, signal)
      const links = [...html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 10)
        .map(match => { const url = new URL(match[1]!.replaceAll('&amp;', '&'), 'https://duckduckgo.com'); return { title: plain(match[2]!), url: url.searchParams.get('uddg') ?? url.href } })
      return { query: value.query, results: links }
    }
    case 'superagent_todo': {
      const value = args as z.infer<typeof schemas.superagent_todo>; runtime.state.put('value', `todo:${binding.id}`, { id: `todo:${binding.id}`, value: JSON.stringify(value.todos) }); return { saved: true }
    }
    case 'superagent_subagent': return runtime.createChild(binding, args as z.infer<typeof schemas.superagent_subagent>, signal)
    case 'superagent_subagent_models': return runtime.modelCatalog()
    case 'superagent_agents': return { agents: runtime.children(binding.id).map(child => ({ agent_id: child.agentId, id: child.id, state: child.status, stopped: !!child.closed })) }
    case 'superagent_agent_message': { const value = args as z.infer<typeof schemas.superagent_agent_message>; await runtime.messageChild(binding, value.agent_id, value.message); return { accepted: true } }
    case 'superagent_interrupt': { const value = args as z.infer<typeof schemas.superagent_interrupt>; await runtime.interruptChild(binding, value.agent_id); return { stopped: true } }
  }
}
