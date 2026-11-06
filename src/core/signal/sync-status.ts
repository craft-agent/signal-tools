import { ToolError } from "../errors"
import { inTransaction, openMirrorForWrite, setMeta, type Mirror } from "./mirror"
import {
  ACCOUNT_UUID_META,
  ERROR_META,
  GROUPS_STALE_META,
  LAST_RECEIVED_AT_META,
  REFRESHED_AT_META,
  STARTED_AT_META,
  STATUS_META,
  SUBSCRIBED_AT_META,
} from "./mirror-meta"

export {
  ACCOUNT_UUID_META,
  ERROR_META,
  GROUPS_STALE_META,
  LAST_RECEIVED_AT_META,
  REFRESHED_AT_META,
  STARTED_AT_META,
  STATUS_META,
  SUBSCRIBED_AT_META,
}

/** Where the sync service of a label stands, as the mirror's `status` records it. */
export type SyncStatus = "starting" | "running" | "stopped" | "unlinked" | "failed"

/** How a run of the sync service ended. */
export type SyncOutcome = {
  /** What a process supervisor needs: 0 when there is nothing to run or a stop was requested, 1 after a failure worth a restart. */
  exitCode: 0 | 1
  status: "not linked" | "unlinked" | "stopped" | "failed"
  /** Why, in words without content, ids or numbers. */
  reason?: string
}

/** What the log says when a label has no linked account. */
export const NOT_LINKED_MESSAGE = "no linked Signal account; link a device first"

/** Records the status and its error (`null` for none) in the mirror's `meta`, in one transaction. */
export function recordStatus(mirror: Mirror, status: SyncStatus, error: string | null = null): void {
  inTransaction(mirror, () => setMeta(mirror, { [STATUS_META]: status, [ERROR_META]: error }))
}

/** Opens the mirror only to record the status, and ignores any failure: for the ends of a run that has no open mirror. */
export function recordStatusAlone(path: string, status: SyncStatus, error: string | null): void {
  try {
    const mirror = openMirrorForWrite(path)
    try {
      recordStatus(mirror, status, error)
    } finally {
      mirror.close()
    }
  } catch {
    // The status is a courtesy to whoever reads it; the run ends as it was going to.
  }
}

/** What an error says without anything from signal-cli's data: a `ToolError`'s message, else only the error's kind. */
export function errorText(error: unknown): string {
  if (error instanceof ToolError) return error.message
  return error instanceof Error ? error.name : "unexpected error"
}
