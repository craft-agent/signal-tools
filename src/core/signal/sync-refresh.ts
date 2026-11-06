import type { DaemonConnection } from "./daemon"
import { upsertContacts, upsertGroups } from "./directory"
import { GROUPS_STALE_META, REFRESHED_AT_META } from "./mirror-meta"
import { inTransaction, setMeta, type Mirror } from "./mirror"
import { RPC_TIMEOUT_MS } from "./sync-options"
import { errorText } from "./sync-status"

export type RefreshContext = {
  connection: DaemonConnection
  mirror: Mirror
  now(): number
  log(line: string): void
  /** Cancels the calls to the daemon. */
  signal: AbortSignal
  /** Whether no group changed since the refresh began, so the group list may be marked as read. */
  groupsUnchanged(): boolean
}

/**
 * Reads the contacts and groups from the daemon and stores them, with the
 * time, in one transaction. A daemon that does not answer is logged and
 * left for the next round; only a mirror that cannot be written throws.
 */
export async function refreshDirectory(context: RefreshContext): Promise<void> {
  const { connection, mirror, now, log, signal, groupsUnchanged } = context
  let contacts: unknown
  let groups: unknown
  try {
    const options = { timeoutMs: RPC_TIMEOUT_MS, signal }
    contacts = await connection.call("listContacts", { allRecipients: true }, options)
    groups = await connection.call("listGroups", { detailed: true }, options)
  } catch (error) {
    if (!signal.aborted) log(`refresh failed: ${errorText(error)}`)
    return
  }
  const counts = inTransaction(mirror, () => {
    const stamp = now()
    const counted = { contacts: upsertContacts(mirror, contacts, stamp), groups: upsertGroups(mirror, groups, stamp) }
    setMeta(mirror, { [REFRESHED_AT_META]: stamp, ...(groupsUnchanged() ? { [GROUPS_STALE_META]: 0 } : {}) })
    return counted
  })
  log(`refreshed ${counts.contacts} contacts, ${counts.groups} groups`)
}
