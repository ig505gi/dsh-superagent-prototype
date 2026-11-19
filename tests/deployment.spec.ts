import { trashSync } from './fixtures/trash.ts'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { trashSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { github: { repository: 'acme/widgets', cli: 'gh' } }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets',
      forge: { kind: 'github', host: 'github.com', cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.forge).toEqual({ kind: 'github', host: 'github.com', cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot',
      noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { github: { repository: 'acme/gadgets', cli: 'gh' } }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), { github }, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads a self-hosted GitLab project from the agent\'s glab, addressing it by its URL-encoded path', async () => {
    const glab = (file: string, body: string): string => program(file, body)
    glab(join(dir, 'bin', 'glab'), [
      'case "$*" in',
      '  "api user --hostname gitlab.example.com") echo \'{"id":9,"username":"Agent-Bot"}\' ;;',
      '  "api projects/group%2Fsub%2Fwidgets --hostname gitlab.example.com") echo \'{"path_with_namespace":"group/sub/widgets","permissions":{"project_access":{"access_level":40}}}\' ;;',
      '  *) echo "unexpected $*" >&2; exit 1 ;;',
      'esac',
    ].join('\n'))
    const deployment = await resolveDeployment(machine(), { gitlab: { host: 'gitlab.example.com', project: 'group/sub/widgets', cli: 'glab' } }, probe, path)
    expect(deployment).toMatchObject({ repository: 'group/sub/widgets',
      forge: { kind: 'gitlab', host: 'gitlab.example.com', login: 'Agent-Bot', cli: join(dir, 'bin', 'glab') } })
    // A self-managed instance has no noreply domain, so the commit address follows the instance.
    expect(deployment.forge.noreply).toBe('Agent-Bot@users.noreply.gitlab.example.com')
  })
  it('keeps the port of an instance served on one, but not in the commit address', async () => {
    program(join(dir, 'bin', 'glab-ported'), `case "$*" in\n  "api user --hostname gitlab.example.com:8443") echo '{"id":9,"username":"Agent-Bot"}' ;;\n  "api projects/group%2Fwidgets --hostname gitlab.example.com:8443") echo '{"path_with_namespace":"group/widgets","permissions":{"project_access":{"access_level":40}}}' ;;\n  *) exit 1 ;;\nesac`)
    const deployment = await resolveDeployment(machine(), { gitlab: { host: 'gitlab.example.com:8443', project: 'group/widgets', cli: 'glab-ported' } }, probe, path)
    expect(deployment.forge.host).toBe('gitlab.example.com:8443')
    expect(deployment.forge.noreply).toBe('Agent-Bot@users.noreply.gitlab.example.com')
  })
  it('names what GitLab setup needs, and refuses two forges at once', async () => {
    const needs = (code: string, values: Record<string, unknown>, gitlab: unknown) =>
      expect(resolveDeployment(machine(), { gitlab }, probe, path)).rejects.toEqual(setupError('gitlab', code, values))
    await needs('gitlabHostUnset', {}, { project: 'group/widgets', cli: 'glab' })
    await needs('projectUnset', {}, { host: 'gitlab.example.com', cli: 'glab' })
    await needs('gitlabCliUnset', {}, { host: 'gitlab.example.com', project: 'group/widgets' })
    await needs('gitlabCliMissing', { output: `${join(dir, 'missing')} is not an executable file` },
      { host: 'gitlab.example.com', project: 'group/widgets', cli: join(dir, 'missing') })
    const signedOut = program(join(dir, 'bin', 'glab-broken'), 'exit 1')
    await needs('gitlabCliSignedOut', {}, { host: 'gitlab.example.com', project: 'group/widgets', cli: signedOut })
    // Guest access is not enough to push, and GitLab reports no permission block to an outsider at all.
    const guest = program(join(dir, 'bin', 'glab-guest'), `case "$*" in\n  "api user --hostname gitlab.example.com") echo '{"id":9,"username":"Agent-Bot"}' ;;\n  *) echo '{"path_with_namespace":"group/widgets","permissions":{"project_access":{"access_level":20}}}' ;;\nesac`)
    await needs('projectReadOnly', { account: 'Agent-Bot', repository: 'group/widgets' },
      { host: 'gitlab.example.com', project: 'group/widgets', cli: guest })
    const outsider = program(join(dir, 'bin', 'glab-outsider'), `case "$*" in\n  "api user --hostname gitlab.example.com") echo '{"id":9,"username":"Agent-Bot"}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    await needs('projectUnreadable', { account: 'Agent-Bot', repository: 'group/widgets', output: expect.stringContaining('HTTP 404') as unknown },
      { host: 'gitlab.example.com', project: 'group/widgets', cli: outsider })
    expect(resolveDeployment(machine(), { github: { repository: 'acme/widgets', cli: 'gh' },
      gitlab: { host: 'gitlab.example.com', project: 'group/widgets', cli: 'glab' } }, probe, path))
      .rejects.toEqual(setupError('deployment', 'forgeAmbiguous'))
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
