import { ToolError } from "../errors"
import { deleteMessage, removeFiles } from "../signal/ingest-delete"
import { editMessage } from "../signal/ingest-edit"
import type { Sender } from "../signal/ingest-messages"
import type { LabelPaths } from "../signal/labels"
import { inTransaction } from "../signal/mirror"
import type { PreparedChat } from "./prepare"
import { recordInMirror } from "./record"

const EDIT_NOT_RECORDED = "the edit was sent but is not in the mirror yet"
const EDIT_DELETED_MEANWHILE = "the edit was sent, but the message has since been deleted for everyone"
const DELETE_NOT_RECORDED = "the message was deleted for everyone but is still in the mirror"

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
  const outcome = recordInMirror(paths, me, EDIT_NOT_RECORDED, (mirror, ctx) => {
    const sender: Sender = { chat: chat.id, author: me, fromMe: true, authorName: null }
    const dataMessage = { timestamp: edit.edited, message: edit.text }
    const stored = inTransaction(mirror, () =>
      editMessage(mirror, ctx, sender, { targetSentTimestamp: edit.timestamp, dataMessage }),
    )
    if (stored === null) throw new ToolError("internal_error", "The mirror did not keep the edit")
    return stored
  })
  if (outcome === "dropped-deleted") throw new ToolError("upstream_error", EDIT_DELETED_MEANWHILE)
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
