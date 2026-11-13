import { z } from "zod"
import { clampLimit, encodeCursor, fitItems, notACursor, readCursor } from "../pages"
import type { Mirror } from "../signal/mirror"
import { chatHeader, existingChat, requireChatId } from "./chat-rows"
import { messageEntries } from "./message"
import { cuttableMessage } from "./message-cut"
import { DATA_NOTE } from "./message-schema"
import { MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { People } from "./people"
import { olderThan, positionOf, readRange, rangeConditions } from "./range"
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
  excluded: ReadonlySet<string>,
): ChatReadOutput {
  const chatId = requireChatId(args.chat, "view")
  const limit = clampLimit(args.limit, LIMITS.view, "limit")
  const range = readRange(args)
  const older = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", viewCursor)
  if (older && older.chat !== chatId) throw notACursor("cursor")
  const chat = existingChat(mirror, me, chatId)

  const bounds = rangeConditions(range)
  const where = ["chat = ?", ...bounds.conditions]
  const params: (string | number)[] = [chat.id, ...bounds.params]
  if (older) {
    const keyset = olderThan(older)
    where.push(keyset.condition)
    params.push(...keyset.params)
  }
  const fetched = mirror
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where.join(" AND ")} ORDER BY ts DESC, author DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as StoredMessage[]
  const page = fetched.slice(0, limit)

  const people = new People(mirror, me, excluded)
  people.load([chat.id])
  const header = chatHeader(chat, people)
  const entries = messageEntries(mirror, people, page, now)
  const assemble = (shown: typeof entries) => ({ chat: header, messages: [...shown].reverse(), note: DATA_NOTE })
  const { items, stopped } = fitItems(assemble, entries, { cuttable: cuttableMessage })
  const result: ChatReadOutput = assemble(items)
  const oldest = page[items.length - 1]
  if (oldest && (stopped || fetched.length > limit))
    result.next = encodeCursor({ ...positionOf(oldest), chat: chat.id })
  return result
}
