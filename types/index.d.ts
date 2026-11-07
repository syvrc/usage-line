/** One rate-limit window as last measured. */
export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** The latest figures the band draws from. */
export type UsageFigures = {
  rateLimits: UsageWindow[]
  /** This session's cost in US dollars; null where the host keeps no ledger. */
  usd: number | null
  /** When these were measured, in $.clock.now() milliseconds. */
  at: number
  /** When the limits last came from the usage service; absent before the first fetch. */
  liveAt?: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-line': {
      figures: UsageFigures | null
      /** When the last main-thread reply finished, in $.clock.now() ms. */
      lastReplyAt: number | null
      /** Bumped on a timer so the cache countdown redraws. */
      tick: number
      /** A fetch the ↻ button started is running. */
      isFetching: boolean
    }
  }
}
