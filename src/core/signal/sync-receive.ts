import { isRecord, maskNumbers } from "./daemon-errors"
import type { Notification } from "./daemon"
import { ingestEnvelope, removeFiles, type IngestResult } from "./ingest"
import { GROUPS_STALE_META, LAST_RECEIVED_AT_META } from "./mirror-meta"
import { getMeta, inTransaction, setMeta, type Mirror } from "./mirror"

/** The method of the notifications that carry a received envelope. */
const RECEIVE_METHOD = "receive"

/** How much of signal-cli's own error text a log line carries. */
const MAX_EXCEPTION_LENGTH = 200

/** Why receiving stopped when the mirror could not be written. */
export const STORAGE_FAILURE_REASON = "the mirror cannot be written; receiving stopped"

export type ReceiverDeps = {
  mirror: Mirror
  /** This account's own id. */
  me: string
  /** signal-cli's directory of received attachments. */
  attachmentsDir: string
  now(): number
  log(line: string): void
  /** Called when a stored envelope left the group list out of date. */
  onGroupsStale(): void
  /** Called once, synchronously, when the mirror cannot be written: whoever owns the daemon stops it there. */
  onStorageFailure(): void
}

/** The result of a `receive` notification, in either shape signal-cli sends it: wrapped by a subscription, or bare. */
function payloadOf(params: unknown): unknown {
  return isRecord(params) && params.subscription !== undefined ? params.result : params
}

/** signal-cli's error text for an envelope it could not decode, masked and cut. */
function exceptionText(exception: unknown): string {
  const text = typeof exception === "string" ? exception : JSON.stringify(exception)
  return maskNumbers(text).slice(0, MAX_EXCEPTION_LENGTH)
}

/**
 * Stores what the daemon emits. Any failure while storing is a storage
 * failure: receiving on with a mirror that cannot be written would lose every
 * envelope that follows, since signal-cli does not hand one on twice.
 */
export class Receiver {
  private readonly deps: ReceiverDeps
  private halted = false

  constructor(deps: ReceiverDeps) {
    this.deps = deps
  }

  /** The listener for the connection's notifications. */
  readonly handle = (notification: Notification): void => {
    if (this.halted || notification.method !== RECEIVE_METHOD) return
    const { mirror, me, attachmentsDir, now, log } = this.deps
    const payload = payloadOf(notification.params)
    if (isRecord(payload) && payload.exception) {
      log(`receive error from signal-cli: ${exceptionText(payload.exception)}`)
    }
    let stored: { result: IngestResult; groupsStale: boolean }
    try {
      const received = now()
      stored = inTransaction(mirror, () => {
        const result = ingestEnvelope(mirror, payload, { me, attachmentsDir, now: received })
        setMeta(mirror, { [LAST_RECEIVED_AT_META]: received })
        return { result, groupsStale: getMeta(mirror)[GROUPS_STALE_META] === "1" }
      })
    } catch {
      this.failStorage()
      return
    }
    removeFiles(stored.result.removeFiles)
    log(`event: ${stored.result.done.join(",")}`)
    if (stored.groupsStale) this.deps.onGroupsStale()
  }

  /** Stops receiving at once: nothing more is stored, and the owner of the daemon is told. */
  failStorage(): void {
    if (this.halted) return
    this.halted = true
    this.deps.onStorageFailure()
    this.deps.log(STORAGE_FAILURE_REASON)
  }

  /** Runs `work`, which writes to the mirror, and treats a throw as a storage failure. */
  async guard(work: () => void | Promise<void>): Promise<void> {
    try {
      await work()
    } catch {
      this.failStorage()
    }
  }
}
