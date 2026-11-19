/** Safe internal failure categories; provider diagnostics never leave this classifier. */
const AUTH = /\b(?:401|403)\b|unauthori[sz]ed|unauthenticated|authentication failed|invalid api key|permission denied/i
const PASSING = /\b(?:408|429|50[0-4])\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|socket hang up|fetch failed|network error|overloaded|rate limit/i

/** Carries only the adapter's own retry decision alongside a fixed public diagnostic. */
export class ManagedProviderError extends Error {
  constructor(readonly retryable: boolean) {
    super('The managed provider failed. Inspect the original Paseo conversation.')
    this.name = 'ManagedProviderError'
  }
}

export function safeProviderFailure(diagnostic: unknown): ManagedProviderError {
  const text = typeof diagnostic === 'string' ? diagnostic.slice(0, 16_384) : ''
  return new ManagedProviderError(!AUTH.test(text) && PASSING.test(text))
}
