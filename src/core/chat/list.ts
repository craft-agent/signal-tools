import { z } from "zod"
import { foldCase } from "../fold"
import { clampLimit, encodeCursor, fitItems, notACursor, readCursor, type Cuttable } from "../pages"
import type { Mirror } from "../signal/mirror"
import { formatLocalTime } from "../time"
import { CHAT_COLUMNS, chatHeader, chatName, chatNumber, personIds, type StoredChat } from "./chat-rows"
import { fingerprint } from "./filter"
import { messageEntries } from "./message"
import { cutMessage, dropMetadata, messageTextLength } from "./message-cut"
import { DATA_NOTE } from "./message-schema"
import { MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { People } from "./people"
import { LIMITS, type ChatEntry, type ChatReadInput, type ChatReadOutput } from "./schema"

/**
 * Where a page of chats stops: the activity time (0 for a chat with no
 * message) and id of its last chat, and the filters it was made under, since a
 * cursor continues one list and no other.
 */
const listCursor = z.strictObject({ ts: z.number().int(), id: z.string(), filter: z.string() })

/** Separators a number is typed with, which a query's digits ignore. */
const NUMBER_SEPARATORS = /[\s().-]/g

/** The chat's last message when it alone exceeds a result's budget is cut like any message. */
const cuttableChat: Cuttable<ChatEntry> = {
  size: (chat) => (chat.last_message ? messageTextLength(chat.last_message) : 0),
  cut: (chat, keep) => (chat.last_message ? { ...chat, last_message: cutMessage(chat.last_message, keep) } : chat),
  drop(chat) {
    const last = chat.last_message ? dropMetadata(chat.last_message) : null
    return last ? { ...chat, last_message: last } : null
  },
}

function activity(chat: StoredChat): number {
  return chat.last_ts ?? 0
}

/** Every chat worth listing, newest activity first and by id among equals: those with a message, and every group. */
function allChats(mirror: Mirror): StoredChat[] {
  return mirror
    .prepare(
      `SELECT ${CHAT_COLUMNS} FROM chats WHERE last_ts IS NOT NULL OR kind = 'group'
       ORDER BY COALESCE(last_ts, 0) DESC, id`,
    )
    .all() as StoredChat[]
}

/** Incoming messages not read yet, by chat. */
function unreadCounts(mirror: Mirror): Map<string, number> {
  const rows = mirror
    .prepare(
      `SELECT chat, COUNT(*) AS unread FROM messages
       WHERE from_me = 0 AND kind = 'message' AND read_at IS NULL GROUP BY chat`,
    )
    .all() as { chat: string; unread: number }[]
  return new Map(rows.map((row) => [row.chat, row.unread]))
}

/** Whether a chat's name holds the folded query, or its number holds the query's digits. */
function matches(chat: StoredChat, people: People, query: string): boolean {
  if (foldCase(chatName(chat, people) ?? "").includes(query)) return true
  const digits = query.replace(NUMBER_SEPARATORS, "")
  return digits !== "" && (chatNumber(chat, people) ?? "").includes(digits)
}

function entryOf(chat: StoredChat, people: People, unread: number): ChatEntry {
  const entry: ChatEntry = { ...chatHeader(chat, people), unread }
  const number = chatNumber(chat, people)
  if (number !== null) entry.number = number
  if (chat.last_ts !== null) entry.last_activity_at = formatLocalTime(chat.last_ts)
  if (chat.expires_in) entry.disappearing_seconds = chat.expires_in
  if (chat.kind === "group" && !chat.member) entry.left = true
  return entry
}

/** The latest message of each chat that has one, newest first among equals by author. */
function lastMessages(mirror: Mirror, chats: readonly StoredChat[]): Map<string, StoredMessage> {
  const latest = mirror.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat = ? ORDER BY ts DESC, author DESC LIMIT 1`,
  )
  const found = new Map<string, StoredMessage>()
  for (const chat of chats) {
    const row = latest.get(chat.id) as StoredMessage | undefined
    if (row) found.set(chat.id, row)
  }
  return found
}

/** Adds `last_message` to each entry: its chat's last message, or null. */
function addLastMessages(
  mirror: Mirror,
  people: People,
  chats: readonly StoredChat[],
  entries: ChatEntry[],
  now: number,
): void {
  const found = lastMessages(mirror, chats)
  const rows = [...found.values()]
  const built = new Map(messageEntries(mirror, people, rows, now).map((entry, index) => [rows[index]!.chat, entry]))
  for (const entry of entries) entry.last_message = built.get(entry.id) ?? null
}

/**
 * The `list` method: chats newest activity first, optionally those whose
 * name or number holds `query`, or that have unread messages, each with its
 * last message on request. Pages by a keyset cursor over (activity, id), so a
 * chat that gains a message between pages is not shown twice.
 */
export function listChats(
  mirror: Mirror,
  me: string | null,
  args: Pick<ChatReadInput, "query" | "unread" | "last" | "limit" | "cursor">,
  now: number,
): ChatReadOutput {
  const limit = clampLimit(args.limit, LIMITS.list, "limit")
  const query = foldCase(args.query ?? "").trim()
  const unreadOnly = args.unread === true
  const after = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", listCursor)
  const filter = fingerprint(query, unreadOnly)
  if (after && after.filter !== filter) throw notACursor("cursor")
  const people = new People(mirror, me)
  const unread = unreadCounts(mirror)
  let chats = allChats(mirror)
  if (after)
    chats = chats.filter((chat) => activity(chat) < after.ts || (activity(chat) === after.ts && chat.id > after.id))
  if (unreadOnly) chats = chats.filter((chat) => (unread.get(chat.id) ?? 0) > 0)
  if (query !== "") {
    people.load(personIds(chats))
    chats = chats.filter((chat) => matches(chat, people, query))
  }
  const page = chats.slice(0, limit)
  people.load(personIds(page))
  const entries = page.map((chat) => entryOf(chat, people, unread.get(chat.id) ?? 0))
  if (args.last) addLastMessages(mirror, people, page, entries, now)
  const { items, stopped } = fitItems((fitting) => ({ chats: fitting, note: DATA_NOTE }), entries, {
    cuttable: cuttableChat,
  })
  const result: ChatReadOutput = { chats: items, note: DATA_NOTE }
  const lastShown = page[items.length - 1]
  if (lastShown && (stopped || chats.length > limit)) {
    result.next = encodeCursor({ ts: activity(lastShown), id: lastShown.id, filter })
  }
  return result
}
