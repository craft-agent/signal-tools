import { readLinkedAccount } from "./account"
import type { LabelPaths } from "./labels"
import type { SignalCliExit } from "./signal-cli"
import type { Ended } from "./sync-ending"
import type { SyncOutcome, SyncStatus } from "./sync-status"

/**
 * What signal-cli prints when Signal no longer knows the device (lowercase).
 * Found in the tail of its standard error, they mean the device was unlinked.
 */
const UNLINKED_MARKERS = [
  "not registered",
  "authorizationfailed",
  "authorization failed",
  "unregistered user",
  "devicelimitexceeded",
  "account is not registered",
]

/** What the mirror's `error` and the outcome say once the device is unlinked. */
export const UNLINKED_REASON = "Signal unlinked this device; link it again"
const CONNECTION_LOST = "the connection to signal-cli was lost"

/** What the run ended with, and what to record and tell about it. */
export type Settled = {
  status: Extract<SyncStatus, "stopped" | "unlinked" | "failed">
  /** For the mirror's `error`; null for none. */
  error: string | null
  /** The line for the log. */
  message: string
  outcome: SyncOutcome
}

/** How signal-cli ended, as a failure reason. */
function describeExit({ code, signal }: SignalCliExit): string {
  return `signal-cli exited (${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`})`
}

/** Whether Signal has unlinked the device: signal-cli said so on its way out, or the account file now says so. */
function unlinked(paths: LabelPaths, tail: readonly string[]): boolean {
  const text = tail.join("\n").toLowerCase()
  if (UNLINKED_MARKERS.some((marker) => text.includes(marker))) return true
  try {
    return readLinkedAccount(paths)?.registered === false
  } catch {
    return false
  }
}

export type SettleInput = {
  ended: Ended
  paths: LabelPaths
  /** How signal-cli ended by itself, or undefined when it was still running when receiving ended. */
  exit: SignalCliExit | undefined
  startError: string | undefined
  tail: readonly string[]
}

/** Decides the outcome of a run from how it ended, with the facts about signal-cli found at the end. */
export function settle({ ended, paths, exit, startError, tail }: SettleInput): Settled {
  if (ended.kind === "stop") {
    return { status: "stopped", error: null, message: "stopped", outcome: { exitCode: 0, status: "stopped" } }
  }
  if (unlinked(paths, tail)) {
    return {
      status: "unlinked",
      error: UNLINKED_REASON,
      message: "Signal unlinked this device; staying down until it is linked again",
      outcome: { exitCode: 0, status: "unlinked", reason: UNLINKED_REASON },
    }
  }
  const reason = ended.reason ?? (exit ? describeExit(exit) : (startError ?? CONNECTION_LOST))
  return {
    status: "failed",
    error: reason,
    message: `sync ended: ${reason}`,
    outcome: { exitCode: 1, status: "failed", reason },
  }
}
