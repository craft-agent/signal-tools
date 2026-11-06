import { isRecord } from "./daemon-errors"
import type { IngestContext } from "./ingest-context"
import { storeMessage, type Sender } from "./ingest-messages"
import type { Mirror } from "./mirror"
import { intOrNull, readAttachments, readMentions, textOrNull, toJson } from "./mirror-parts"
import { findMessage, isDeleted, recordDeleted } from "./mirror-rows"

/**
 * An edit. The message takes the new text and files only when the edit is
 * newer than the version it shows, and keeps every other version in its
 * history: an older edit that arrives late goes to the history only, and an
 * edit already known changes nothing. An edit of a message the mirror never
 * saw is stored as the message. An edit of a message that was deleted for
 * everyone is dropped.
 *
 * Returns "edit", "dropped-deleted", or null when the edit is unreadable.
 */
export function editMessage(
  mirror: Mirror,
  ctx: IngestContext,
  sender: Sender,
  edit: Record<string, unknown>,
): "edit" | "dropped-deleted" | null {
  const { author } = sender
  const target = intOrNull(edit.targetSentTimestamp)
  const data = isRecord(edit.dataMessage) ? edit.dataMessage : null
  const editTs = data ? intOrNull(data.timestamp) : null
  if (!data || target === null || editTs === null) return null
  if (isDeleted(mirror, author, target) || isDeleted(mirror, author, editTs)) {
    recordDeleted(mirror, author, [target, editTs], ctx.now)
    return "dropped-deleted"
  }
  const row = findMessage(mirror, author, target)
  if (!row) {
    return storeMessage(mirror, ctx, sender, { ...data, timestamp: target }, editTs) === "message" ? "edit" : null
  }
  const current = row.edited ?? row.ts
  const body = textOrNull(data.message)
  const attachments = toJson(readAttachments(data.attachments))
  const mentions = toJson(readMentions(data.mentions))
  const addVersion = mirror.prepare(
    "INSERT OR IGNORE INTO edits (author, ts, rev_ts, body, attachments, mentions) VALUES (?, ?, ?, ?, ?, ?)",
  )
  if (editTs < current) {
    // Delivered late: part of the history, not the version the message shows.
    addVersion.run(author, row.ts, editTs, body, attachments, mentions)
  } else if (editTs > current) {
    addVersion.run(author, row.ts, current, row.body, row.attachments, row.mentions)
    mirror
      .prepare(
        `UPDATE messages SET body = ?, attachments = COALESCE(?, attachments), edited = ?, mentions = ?
         WHERE author = ? AND ts = ?`,
      )
      .run(body, attachments, editTs, mentions, author, row.ts)
  }
  return "edit"
}
