import { requireChat } from "../chat/chat-rows"
import { readList } from "../chat/message-rows"
import { ToolError } from "../errors"
import { isDeleted, hasDisappeared } from "../signal/mirror-rows"
import type { Mirror } from "../signal/mirror"
import type { StoredAttachment } from "../signal/mirror-parts"
import { parseMessageId } from "../signal/ids"
import { FILE_SAVE_TOOL_ID, GONE_MESSAGE, NO_FILES_MESSAGE, UNKNOWN_MESSAGE, VIEW_ONCE_MESSAGE } from "./constants"

/** One file of a message as the mirror has it. */
export type SourceFile = {
  /** Its place among the message's files, from 1. */
  index: number
  /** Its name in signal-cli's store; never shown. */
  id?: string
  name?: string
  type?: string
}

/** The files of one message, and what the message says about keeping them. */
export type MessageFiles = {
  chat: string
  author: string
  ts: number
  files: SourceFile[]
  /** Whether the message disappears after a time, so its files are for the user only. */
  disappearing: boolean
}

type FileRow = {
  kind: "message" | "timer"
  attachments: string | null
  expires_in: number
  expire_start: number | null
  view_once: number
}

/** The message id a call names, or `invalid_argument` when it is not one. */
export function messageReference(id: string): { author: string; ts: number } {
  const reference = parseMessageId(id)
  if (!reference) {
    throw new ToolError(
      "invalid_argument",
      "id must be a message id, `<account id>:<sent time in ms>`, as a result gives it.",
    )
  }
  return reference
}

/**
 * The files of the message `id` in `chat`, read from the mirror. A message the
 * mirror does not have, one deleted for everyone and one that has disappeared
 * are `not_found`, so is one with no files (a timer change included); a
 * view-once message is `forbidden`, since its sender meant its files to be
 * seen once.
 */
export function findMessageFiles(
  mirror: Mirror,
  me: string | null,
  chatId: string,
  id: string,
  now: number,
): MessageFiles {
  const reference = messageReference(id)
  const chat = requireChat(mirror, me, chatId, FILE_SAVE_TOOL_ID)
  const row = mirror
    .prepare(
      "SELECT kind, attachments, expires_in, expire_start, view_once FROM messages WHERE chat = ? AND author = ? AND ts = ?",
    )
    .get(chat.id, reference.author, reference.ts) as FileRow | undefined
  if (!row) {
    throw new ToolError("not_found", isDeleted(mirror, reference.author, reference.ts) ? GONE_MESSAGE : UNKNOWN_MESSAGE)
  }
  if (hasDisappeared(row, now)) throw new ToolError("not_found", GONE_MESSAGE)
  if (row.view_once) throw new ToolError("forbidden", VIEW_ONCE_MESSAGE)
  const attachments = row.kind === "timer" ? [] : readList<StoredAttachment>(row.attachments)
  if (attachments.length === 0) throw new ToolError("not_found", NO_FILES_MESSAGE)
  return {
    chat: chat.id,
    ...reference,
    disappearing: row.expires_in > 0,
    files: attachments.map((item, position) => ({
      index: position + 1,
      id: item.id,
      name: item.name,
      type: item.type,
    })),
  }
}
