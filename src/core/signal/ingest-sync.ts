import { isRecord } from "./daemon-errors"
import { accountId } from "./ids"
import { absorb, type IngestContext, type IngestResult } from "./ingest-context"
import { editMessage } from "./ingest-edit"
import { applyDataMessage, groupChatOf, type Sender } from "./ingest-messages"
import { intOrNull, textOrNull } from "./mirror-parts"
import { setMeta, type Mirror } from "./mirror"
import { contactUuid, findMessage, touchChat } from "./mirror-rows"

/** The sync types that say the contacts or the groups changed on another device. */
const DIRECTORY_SYNC_TYPES = ["CONTACTS_SYNC", "GROUPS_SYNC"]

/** A message this account sent from another device: its transcript, to a person, a group or itself. */
function applySent(mirror: Mirror, ctx: IngestContext, sent: Record<string, unknown>): IngestResult {
  const edit = isRecord(sent.editMessage) ? sent.editMessage : null
  const group = groupChatOf(sent, edit?.dataMessage)
  const number = textOrNull(sent.destinationNumber)
  const chat = group === undefined ? (accountId(sent.destinationUuid) ?? contactUuid(mirror, number)) : group
  if (!chat) return { done: ["sent-unknown-chat"], removeFiles: [] }
  if (group === undefined && number) touchChat(mirror, chat, intOrNull(sent.timestamp) ?? ctx.now, ctx.now, number)
  const sender: Sender = { chat, author: ctx.me, fromMe: true, authorName: null }
  if (edit) return { done: [editMessage(mirror, ctx, sender, edit) ?? "edit-skipped"], removeFiles: [] }
  return applyDataMessage(mirror, ctx, sender, sent)
}

/**
 * A received message was read on another device. Signal starts a received
 * message's disappearing timer when it is read, so the time of this sync is
 * when the timer started.
 */
function applyRead(mirror: Mirror, ctx: IngestContext, read: unknown): string[] {
  if (!isRecord(read)) return []
  const author = accountId(read.senderUuid) ?? contactUuid(mirror, read.senderNumber)
  const ts = intOrNull(read.timestamp)
  if (!author || ts === null) return []
  const row = findMessage(mirror, author, ts)
  if (row) {
    mirror
      .prepare(
        `UPDATE messages SET read_at = COALESCE(read_at, ?),
           expire_start = CASE WHEN expires_in > 0 THEN COALESCE(expire_start, ?) END
         WHERE author = ? AND ts = ?`,
      )
      .run(ctx.now, ctx.now, author, row.ts)
  }
  return ["read"]
}

/** Applies one sync message from another device of this account; see `applyDataMessage` for what it returns. */
export function applySyncMessage(mirror: Mirror, ctx: IngestContext, sync: Record<string, unknown>): IngestResult {
  const result: IngestResult = { done: [], removeFiles: [] }
  if (isRecord(sync.sentMessage)) absorb(result, applySent(mirror, ctx, sync.sentMessage))
  if (Array.isArray(sync.readMessages)) {
    for (const read of sync.readMessages as unknown[]) result.done.push(...applyRead(mirror, ctx, read))
  }
  if (typeof sync.type === "string" && DIRECTORY_SYNC_TYPES.includes(sync.type)) {
    setMeta(mirror, { groups_stale: 1 })
    result.done.push(sync.type.toLowerCase().replace("_", "-"))
  }
  return result
}
