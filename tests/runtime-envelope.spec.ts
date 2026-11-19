import { expect, it } from 'vitest'
import { deliveryBody, deliveryReference, digest, stableId } from '../src/runtime/envelope.ts'

it('recovers an intact delivery ID even when the body contains newlines and Unicode', () => {
  const text = '处理请求\nInclude the original data'
  const body = deliveryBody('original-id', text)
  expect(deliveryReference(body)).toEqual({ id: 'original-id', digest: digest(text) })
  expect(deliveryReference(body + '\nextra text')).toBeUndefined()
  expect(deliveryReference('[superagent-delivery bm90LWpzb24]\ntext')).toBeUndefined()
  expect(stableId('one')).toBe(stableId('one'))
  expect(stableId('one')).not.toBe(stableId('two'))
})
