import { z } from "zod"
import { ToolError } from "../errors"
import { clampLimit, encodeCursor, fitItems, notACursor, readCursor } from "../pages"
import { isChatId } from "../signal/ids"
import type { Mirror } from "../signal/mirror"
import { parseTimeArgument } from "../time"
import { chatName, findChat, shownName } from "./chat-rows"
import { messageEntries } from "./message"
import { cuttableMessage } from "./message-cut"
import { DATA_NOTE } from "./message-schema"
import { MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { People } from "./people"
import { LIMITS, type ChatReadInput, type ChatReadOutput } from "./schema"

/** Where a page of messages stops: the time and author of its oldest message, in the chat it was read from. */
const viewCursor = z.strictObject({ ts: z.number().int(), author: z.string(), chat: z.string() })

/**
 * The `view` method: the newest messages of one chat between `after` and
 * `before` (both exclusive), returned oldest first. `next` continues with
 * older ones, from the oldest message returned.
 */
export function viewChat(
  mirror: Mirror,
  me: string | null,
  args: Pick<ChatReadInput, "chat" | "after" | "before" | "limit" | "cursor">,
  now: number,
): ChatReadOutput {
  if (args.chat === undefined) {
    throw new ToolError("invalid_argument", "chat is required for view: pass a chat id from list.")
  }
  if (!isChatId(args.chat)) {
    throw new ToolError(
      "invalid_argument",
      "chat must be a chat id (a person's account id, or group:<id>) from list; a name or number is not accepted.",
    )
  }
  const limit = clampLimit(args.limit, LIMITS.view, "limit")
  const after = args.after === undefined ? undefined : parseTimeArgument(args.after, "after")
  const before = args.before === undefined ? undefined : parseTimeArgument(args.before, "before")
  const older = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", viewCursor)
  if (older && older.chat !== args.chat) throw notACursor("cursor")
  const chat = findChat(mirror, args.chat)
  if (!chat) throw new ToolError("not_found", "No chat with this id in this account's mirror.")

  const where = ["chat = ?"]
  const params: (string | number)[] = [chat.id]
  if (after !== undefined) {
    where.push("ts > ?")
    params.push(after)
  }
  if (before !== undefined) {
    where.push("ts < ?")
    params.push(before)
  }
  if (older) {
    where.push("(ts < ? OR (ts = ? AND author < ?))")
    params.push(older.ts, older.ts, older.author)
  }
  const fetched = mirror
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where.join(" AND ")} ORDER BY ts DESC, author DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as StoredMessage[]
  const page = fetched.slice(0, limit)

  const people = new People(mirror, me)
  people.load([chat.id])
  const header = { id: chat.id, kind: chat.kind, ...shownName(chatName(chat, people)) }
  const entries = messageEntries(mirror, people, page, now)
  const assemble = (shown: typeof entries) => ({ chat: header, messages: [...shown].reverse(), note: DATA_NOTE })
  const { items, stopped } = fitItems(assemble, entries, { cuttable: cuttableMessage })
  const result: ChatReadOutput = assemble(items)
  const oldest = page[items.length - 1]
  if (oldest && (stopped || fetched.length > limit))
    result.next = encodeCursor({ ts: oldest.ts, author: oldest.author, chat: chat.id })
  return result
}
