import { ToolError } from "../errors"
import type { IngestContext } from "../signal/ingest-context"
import { deleteMessage, removeFiles } from "../signal/ingest-delete"
import { editMessage } from "../signal/ingest-edit"
import type { Sender } from "../signal/ingest-messages"
import type { LabelPaths } from "../signal/labels"
import { inTransaction, type Mirror } from "../signal/mirror"
import type { PreparedChat } from "./prepare"
import { recordInMirror } from "./record"

const DELETE_NOT_RECORDED = "the message was deleted for everyone but is still in the mirror"

type RecordAction = "edit" | "reaction"

/** The sender record for actions made by the user from this account. */
function ownSender(chat: string, author: string): Sender {
  return { chat, author, fromMe: true, authorName: null }
}

/**
 * Records an update (edit or reaction) in the mirror, rolling back on failure
 * and checking whether the message was deleted for everyone meanwhile.
 */
function recordUpdate(
  paths: LabelPaths,
  me: string,
  action: RecordAction,
  apply: (mirror: Mirror, ctx: IngestContext) => "ok" | "dropped-deleted" | null,
): void {
  const outcome = recordInMirror(paths, me, `the ${action} was sent but is not in the mirror yet`, (mirror, ctx) => {
    const stored = inTransaction(mirror, () => apply(mirror, ctx))
    if (!stored) throw new ToolError("internal_error", `The mirror did not keep the ${action}`)
    return stored
  })
  if (outcome === "dropped-deleted") {
    throw new ToolError("upstream_error", `the ${action} was sent, but the message has since been deleted for everyone`)
  }
}

/**
 * Records an edit Signal accepted in the label's mirror, as the sync service
 * stores an edit the user makes on another device: one transaction, by
 * `editMessage`. `timestamp` is the sent time of the message and `edited` that
 * of the edit. Any failure throws a `ToolError` that says the edit was sent but
 * is not in the mirror yet, or, for a message deleted for everyone since (the
 * edit is dropped, as ingest drops it), that the message has been deleted.
 */
export function recordEdit(
  paths: LabelPaths,
  { chat, me }: PreparedChat,
  edit: { timestamp: number; edited: number; text: string },
): void {
  recordUpdate(paths, me, "edit", (mirror, ctx) => {
    const dataMessage = { timestamp: edit.edited, message: edit.text }
    const stored = editMessage(mirror, ctx, ownSender(chat.id, me), {
      targetSentTimestamp: edit.timestamp,
      dataMessage,
    })
    return stored === "dropped-deleted" ? "dropped-deleted" : stored === "edit" ? "ok" : null
  })
}

/**
 * Records a delete for everyone Signal accepted in the label's mirror, as the
 * sync service stores one the user makes on another device: one transaction,
 * by `deleteMessage`, then the message's files are removed once it has
 * committed. Any failure throws a `ToolError` that says the message was
 * deleted for everyone but is still in the mirror.
 */
export function recordDelete(paths: LabelPaths, { me }: PreparedChat, timestamp: number): void {
  const files = recordInMirror(paths, me, DELETE_NOT_RECORDED, (mirror, ctx) =>
    inTransaction(mirror, () => deleteMessage(mirror, ctx, me, timestamp)),
  )
  removeFiles(files ?? [])
}
