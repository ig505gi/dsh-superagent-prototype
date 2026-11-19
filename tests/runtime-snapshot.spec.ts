import { expect, it } from 'vitest'
import { contextBlock, snapshotBody, stripContextBlocks } from '../src/runtime/snapshot.ts'

it('renders a length- and hash-delimited snapshot with current prompt, policy, skills and notices', () => {
  const body = snapshotBody({ role: 'orchestrator', promptRevision: 5, policyRevision: 'policy-1', skillsRevision: 5,
    prompt: '更新后的指令\n</superagent_context_v1>', policy: 'Current policy', skills: 'Current skills',
    notices: [{ id: 'notice-1', text: 'Current notice', summary: 'Settings updated' }] })
  const block = contextBlock(body)
  expect(body).toContain('更新后的指令')
  expect(body).toContain('Current policy')
  expect(body).toContain('Current skills')
  expect(body).toContain('[notice-1] Settings updated\nCurrent notice')
  expect(stripContextBlocks(block + '\nInput')).toEqual({ text: '\nInput', removed: 1 })
  expect(() => stripContextBlocks(block.replace('Current notice', 'Altered notice'))).toThrow('integrity check failed')
})
