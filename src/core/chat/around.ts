import { ToolError } from "../errors"
import { fitItems } from "../pages"
import { parseMessageId } from "../signal/ids"
import type { Mirror } from "../signal/mirror"
import { chatHeader, requireChat } from "./chat-rows"
import { messageEntries } from "./message"
import { cuttableMessage } from "./message-cut"
import { MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { DATA_NOTE, type MessageEntry } from "./message-schema"
import { People } from "./people"
import { AROUND_COUNT, type ChatReadInput, type ChatReadOutput } from "./schema"

/** Room kept in an `around` result for the counts of what was left out. */
const TRIMMED_RESERVE = 100

/** A count argument: its default when absent, the most when above it, `invalid_argument` below 0. */
function countArgument(count: number | undefined, name: string): number {
  if (count === undefined) return AROUND_COUNT.default
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ToolError(
      "invalid_argument",
      `${name} must be a whole number from 0 to ${AROUND_COUNT.max}; 0 asks for none.`,
    )
  }
  return Math.min(count, AROUND_COUNT.max)
}

/**
 * The `around` method: the message `id` of a chat with up to `before_count`
 * messages before it and `after_count` after it, oldest first. When they do
 * not fit in a result, the anchor stays and the messages farthest from it go,
 * alternately from the two sides, and the result counts what was left out
 * under `trimmed_before` and `trimmed_after`. There is no cursor: ask again
 * with the id of the message at the edge to read further.
 */
export function aroundMessage(
  mirror: Mirror,
  me: string | null,
  args: Pick<ChatReadInput, "chat" | "id" | "before_count" | "after_count">,
  now: number,
): ChatReadOutput {
  const chat = requireChat(mirror, me, args.chat, "around")
  if (args.id === undefined) {
    throw new ToolError("invalid_argument", "id is required for around: pass the id of a message.")
  }
  const anchorId = parseMessageId(args.id)
  if (!anchorId) {
    throw new ToolError(
      "invalid_argument",
      "id must be a message id, `<account id>:<sent time in ms>`, as a result gives it.",
    )
  }
  const beforeCount = countArgument(args.before_count, "before_count")
  const afterCount = countArgument(args.after_count, "after_count")

  const anchor = mirror
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat = ? AND author = ? AND ts = ?`)
    .get(chat.id, anchorId.author, anchorId.ts) as StoredMessage | undefined
  if (!anchor) throw new ToolError("not_found", "No message with this id in this chat.")
  const side = (comparison: "<" | ">", order: "DESC" | "ASC", count: number) =>
    mirror
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE chat = ? AND (ts ${comparison} ? OR (ts = ? AND author ${comparison} ?))
         ORDER BY ts ${order}, author ${order} LIMIT ?`,
      )
      .all(chat.id, anchor.ts, anchor.ts, anchor.author, count) as StoredMessage[]
  const older = side("<", "DESC", beforeCount)
  const newer = side(">", "ASC", afterCount)

  const people = new People(mirror, me)
  people.load([chat.id])
  const header = chatHeader(chat, people)
  const [anchorEntry, ...rest] = messageEntries(mirror, people, [anchor, ...older, ...newer], now)
  const olderEntries = rest.slice(0, older.length)
  const newerEntries = rest.slice(older.length)

  // Candidates by distance from the anchor, one side then the other, so trimming takes both ends evenly.
  const candidates: MessageEntry[] = [anchorEntry!]
  for (let distance = 0; distance < Math.max(olderEntries.length, newerEntries.length); distance += 1) {
    const before = olderEntries[distance]
    const after = newerEntries[distance]
    if (before) candidates.push(before)
    if (after) candidates.push(after)
  }
  // Where each message sits relative to the anchor: negative before it, positive after it. An entry may come back cut, so it is looked up by id.
  const place = new Map<string, number>([
    ...olderEntries.map((entry, distance): [string, number] => [entry.id, -(distance + 1)]),
    [anchorEntry!.id, 0],
    ...newerEntries.map((entry, distance): [string, number] => [entry.id, distance + 1]),
  ])
  const assemble = (shown: MessageEntry[]) => ({
    chat: header,
    anchor: anchorEntry!.id,
    messages: [...shown].sort((a, b) => place.get(a.id)! - place.get(b.id)!),
    note: DATA_NOTE,
  })
  const { items } = fitItems(assemble, candidates, { cuttable: cuttableMessage, reserve: TRIMMED_RESERVE })
  const result: ChatReadOutput = assemble(items)
  const keptBefore = items.filter((entry) => place.get(entry.id)! < 0).length
  const keptAfter = items.filter((entry) => place.get(entry.id)! > 0).length
  if (keptBefore < olderEntries.length) result.trimmed_before = olderEntries.length - keptBefore
  if (keptAfter < newerEntries.length) result.trimmed_after = newerEntries.length - keptAfter
  return result
}
