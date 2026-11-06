/** How long the daemon may take to open its socket: a native signal-cli starts in seconds, the first start migrates data. */
const DEFAULT_SOCKET_WAIT_MS = 180_000
/** How often contacts and groups are read again. */
const DEFAULT_REFRESH_EVERY_MS = 30 * 60 * 1000
/** How long envelopes the daemon emitted just before it ended may still be read. */
const DEFAULT_DRAIN_MS = 10_000
/** Below this much free space in the label's directory the service does not receive. */
const DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024
/** How long a service that found the disk full waits before it reports the failure, so a supervisor does not restart it at once. */
const DEFAULT_DISK_WAIT_MS = 60_000
/** How long a daemon that was sent SIGTERM may take to exit before it is sent SIGKILL. */
const DEFAULT_STOP_GRACE_MS = 15_000

/** How long one call to the daemon may take. */
export const RPC_TIMEOUT_MS = 60_000

export type SyncOptions = {
  stateDir: string
  label: string
  /** The signal-cli executable. */
  program: string
  /** Where `signalCliEnv` takes signal-cli's environment from. */
  env: Record<string, string | undefined>
  /** Receives each line of the service's log: masked, without numbers, ids or content. */
  log(line: string): void
  /** A stop request: the service stops its daemon, stores what is still arriving and resolves as `stopped`. */
  signal?: AbortSignal
  /** The clock for the times stored in the mirror, in milliseconds; `Date.now` by default. */
  now?: () => number
  /** How long the daemon may take to open its socket; 3 minutes by default. */
  socketWaitMs?: number
  /** How often contacts and groups are read again; 30 minutes by default. */
  refreshEveryMs?: number
  /** How long envelopes still arriving after a stop or an exit are stored; 10 seconds by default. */
  drainMs?: number
  /** The free space the label's directory needs; 64 MiB by default. */
  minFreeBytes?: number
  /** How long to wait before reporting a full disk; 60 seconds by default. */
  diskWaitMs?: number
  /** How long a daemon that was sent SIGTERM may take to exit before SIGKILL; 15 seconds by default. */
  stopGraceMs?: number
}

/** `SyncOptions` with every default filled in. */
export type ResolvedSyncOptions = Required<Omit<SyncOptions, "signal">> & { signal?: AbortSignal }

export function resolveOptions(options: SyncOptions): ResolvedSyncOptions {
  return {
    ...options,
    now: options.now ?? Date.now,
    socketWaitMs: options.socketWaitMs ?? DEFAULT_SOCKET_WAIT_MS,
    refreshEveryMs: options.refreshEveryMs ?? DEFAULT_REFRESH_EVERY_MS,
    drainMs: options.drainMs ?? DEFAULT_DRAIN_MS,
    minFreeBytes: options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES,
    diskWaitMs: options.diskWaitMs ?? DEFAULT_DISK_WAIT_MS,
    stopGraceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
  }
}
