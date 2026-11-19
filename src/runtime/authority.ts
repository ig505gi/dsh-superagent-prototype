/** Carry the server's invocation guard through asynchronous business handlers to their commit boundary. */
import { AsyncLocalStorage } from 'node:async_hooks'

const current = new AsyncLocalStorage<() => void>()
export const assertToolAuthority = (): void => { current.getStore()?.() }
export const withToolAuthority = <T>(assert: () => void, execute: () => T): T => current.run(assert, execute)
export const outsideToolAuthority = <T>(execute: () => T): T => current.exit(execute)
