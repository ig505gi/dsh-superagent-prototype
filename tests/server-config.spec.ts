import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../src/limits.ts'
import { configView, loadConfig } from '../src/server/config.ts'

const base = { stateDir: '/tmp/standalone-state' }

describe('standalone configuration', () => {
  it('defaults to loopback and keeps the existing machine limits', () => {
    const config = loadConfig(base)
    expect(config).toMatchObject({ host: '127.0.0.1', port: 3083, publicOrigin: 'http://127.0.0.1:3083',
      allowedHosts: ['127.0.0.1:3083', 'localhost:3083'], promptMaxChars: 100_000,
      admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000,
      paseo: { endpoint: '127.0.0.1:6767', main: {}, worker: {} } })
    const view = configView(config)
    view.allowedHosts.push('changed')
    expect(config.allowedHosts).not.toContain('changed')
  })

  it('accepts an explicit private bind, origin, hosts and Paseo role settings', () => {
    const config = loadConfig({ ...base, host: '10.1.2.3', port: 3084, publicOrigin: 'https://panel.example:8443',
      allowedHosts: ['panel.example:8443', '10.1.2.3:3084'],
      paseo: { endpoint: 'wss://paseo.example:6767', main: { provider: 'codex', model: 'example', cwd: '/work/main' },
        worker: { provider: 'codex', modeId: 'full-access' } }, promptMaxChars: LIMITS.promptMaxChars.max,
      admissionContextMaxPages: LIMITS.admissionContextMaxPages.min, admissionContextTimeoutMs: LIMITS.admissionContextTimeoutMs.max })
    expect(config.publicOrigin).toBe('https://panel.example:8443')
    expect(config.paseo.main.cwd).toBe('/work/main')
    expect(loadConfig({ ...base, host: '::1' }).publicOrigin).toBe('http://[::1]:3083')
    expect(loadConfig({ ...base, host: '100.64.0.1', paseo: { endpoint: 'ws://127.0.0.1:6767/ws' } }).host).toBe('100.64.0.1')
  })

  it('trims instance names and loads both multi-instance examples', () => {
    expect(loadConfig({ ...base, instanceId: ' project A ' }).instanceId).toBe('project A')
    expect(loadConfig({ ...base, instanceId: 'a'.repeat(64) }).instanceId).toHaveLength(64)
    const [first, second] = ['project-a', 'project-b'].map(name =>
      loadConfig(JSON.parse(readFileSync(new URL(`../examples/multi-instance/${name}.json`, import.meta.url), 'utf8'))))
    expect(first).toMatchObject({ instanceId: 'project-a', stateDir: '/var/lib/superagent/project-a', port: 3083, paseo: { endpoint: '127.0.0.1:6767' } })
    expect(second).toMatchObject({ instanceId: 'project-b', stateDir: '/var/lib/superagent/project-b', port: 3084, paseo: { endpoint: '127.0.0.1:6767' } })
  })

  it.each([
    { ...base, instanceId: '  ' }, { ...base, instanceId: 'a'.repeat(65) }, { ...base, instanceId: 123 },
    { stateDir: 'relative' }, { stateDir: '/tmp/a', extra: 'secret-should-not-appear' },
    { ...base, paseo: { password: 'secret-should-not-appear' } }, { ...base, paseo: { main: { extra: true } } },
    { ...base, host: '0.0.0.0' }, { ...base, host: '8.8.8.8' }, { ...base, host: 'localhost' },
    { ...base, host: '::' }, { ...base, host: 'fe80::1%en0' },
    { ...base, port: 0 }, { ...base, port: 65536 }, { ...base, port: 3083.5 },
    { ...base, publicOrigin: 'http://user:secret-should-not-appear@example.com' },
    { ...base, publicOrigin: 'http://panel.example/path' }, { ...base, publicOrigin: 'http://panel.example:' },
    { ...base, publicOrigin: 'file:///tmp/x' },
    { ...base, allowedHosts: ['evil.example'] }, { ...base, allowedHosts: ['127.0.0.1:3083/path'] },
    { ...base, paseo: { endpoint: 'ws://user:secret-should-not-appear@paseo.example' } },
    { ...base, paseo: { endpoint: 'ws://paseo.example/?token=secret-should-not-appear' } },
    { ...base, paseo: { endpoint: 'http://127.0.0.1:6767' } }, { ...base, paseo: { endpoint: 'paseo.example' } },
    { ...base, paseo: { endpoint: 'ws://paseo.example:' } },
    { ...base, promptMaxChars: LIMITS.promptMaxChars.min - 1 },
    { ...base, admissionContextMaxPages: LIMITS.admissionContextMaxPages.max + 1 },
    { ...base, admissionContextTimeoutMs: LIMITS.admissionContextTimeoutMs.min - 1 },
  ])('rejects invalid or unknown input without exposing its values', input => {
    expect(() => loadConfig(input)).toThrowError(/^Invalid standalone configuration$/)
  })
})
