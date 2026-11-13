import { z } from "zod"
import { clampLimit, encodeCursor, fitItems, notACursor, readCursor } from "../pages"
import type { Mirror } from "../signal/mirror"
import { formatLocalTime } from "../time"
import { chatHeader, findChats, optionalChat, personIds, type StoredChat } from "./chat-rows"
import { excludedCondition } from "./excluded"
import { fingerprint } from "./filter"
import { messageEntries } from "./message"
import { cuttableMessage } from "./message-cut"
import { MESSAGE_COLUMNS, type StoredMessage } from "./message-rows"
import { DATA_NOTE, type MessageEntry } from "./message-schema"
import { People } from "./people"
import { olderThan, positionOf, rangeConditions, readRange, type Position } from "./range"
import { LIMITS, type ChatReadInput, type ChatReadOutput } from "./schema"
import { matchesAllWords, searchWords } from "./search-match"

/** How a search walks the history: this many messages per query, and at most this many looked through per call. */
export type ScanLimits = { chunk: number; maxScanned: number }

/** Default limits on a search scan: rows per chunk and maximum rows looked through per call. */
export const SCAN_LIMITS: ScanLimits = { chunk: 1000, maxScanned: 20_000 }

/** Where a page of hits stops: the time and author of the oldest message looked through, and the search it belongs to. */
const searchCursor = z.strictObject({ ts: z.number().int(), author: z.string(), filter: z.string() })

/** What a search looks through: the conditions on `messages` that every chunk shares, and their parameters. */
export type ScanScope = { conditions: string[]; params: (string | number)[] }

/**
 * The query for the chunk of messages, newest first, that follows `after`.
 * Across every chat it is served in order by the `messages_ts` index, which
 * also seeks to `after`, so a chunk costs its own rows and not the history
 * before it.
 */
export function chunkStatement(
  scope: ScanScope,
  after: Position | undefined,
): { sql: string; params: (string | number)[] } {
  const conditions = [...scope.conditions]
  const params = [...scope.params]
  if (after) {
    const keyset = olderThan(after)
    conditions.push(keyset.condition)
    params.push(...keyset.params)
  }
  const sql = `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${conditions.join(" AND ")} ORDER BY ts DESC, author DESC LIMIT ?`
  return { sql, params }
}

/** The messages, newest first, that may hold hits, a chunk at a time from `after`; `more` says whether older ones remain. */
function nextChunk(
  mirror: Mirror,
  scope: ScanScope,
  after: Position | undefined,
  chunk: number,
): { rows: StoredMessage[]; more: boolean } {
  const { sql, params } = chunkStatement(scope, after)
  const rows = mirror.prepare(sql).all(...params, chunk + 1) as StoredMessage[]
  return { rows: rows.slice(0, chunk), more: rows.length > chunk }
}

/** The chat of each hit, named, or just its id when the mirror has no row for it. */
function chatRefs(mirror: Mirror, people: People, hits: readonly StoredMessage[]): Map<string, MessageEntry["chat"]> {
  const ids = [...new Set(hits.map((hit) => hit.chat))]
  const chats = findChats(mirror, ids)
  people.load(personIds([...chats.values()]))
  const refs = new Map<string, MessageEntry["chat"]>()
  for (const id of ids) {
    const chat: StoredChat | undefined = chats.get(id)
    refs.set(id, chat ? chatHeader(chat, people) : undefined)
  }
  return refs
}

/**
 * The `search` method: messages, newest first, whose text, file names or
 * captions hold every word of `query` (case and script forms folded), in one
 * chat or all, between `after` and `before`.
 *
 * The history is walked in chunks by (time, author) until the page is full,
 * the history ends, or `scan.maxScanned` messages have been looked through.
 * A full page returns a `next` from its last hit, which may lead to an empty
 * page when nothing older matches. Stopping at the scan limit returns the hits
 * found so far with `scanned_to`, the time reached, and a `next` that
 * continues from there.
 */
export function searchMessages(
  mirror: Mirror,
  me: string | null,
  args: Pick<ChatReadInput, "query" | "chat" | "after" | "before" | "limit" | "cursor">,
  now: number,
  excluded: ReadonlySet<string>,
  scan: ScanLimits = SCAN_LIMITS,
): ChatReadOutput {
  const words = searchWords(args.query)
  const chat = optionalChat(mirror, me, args.chat, "search")
  const limit = clampLimit(args.limit, LIMITS.search, "limit")
  const range = readRange(args)
  const filter = fingerprint(
    [...words].sort(),
    chat?.id ?? null,
    range.after ?? null,
    range.before ?? null,
    [...excluded].sort(),
  )
  const resume = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", searchCursor)
  if (resume && resume.filter !== filter) throw notACursor("cursor")

  const bounds = rangeConditions(range)
  const left = excludedCondition("chat", excluded)
  const base = {
    conditions: ["kind = 'message'", ...(chat ? ["chat = ?"] : []), ...(left ? [left.sql] : []), ...bounds.conditions],
    params: [...(chat ? [chat.id] : []), ...(left?.params ?? []), ...bounds.params],
  }
  const hits: StoredMessage[] = []
  let position: Position | undefined = resume && { ts: resume.ts, author: resume.author }
  let scanned = 0
  let lastScanned: StoredMessage | undefined
  let exhausted = false
  let full = false
  walk: for (;;) {
    const { rows, more } = nextChunk(mirror, base, position, scan.chunk)
    for (const [index, row] of rows.entries()) {
      scanned += 1
      lastScanned = row
      if (matchesAllWords(row, words)) hits.push(row)
      const rowsRemain = more || index < rows.length - 1
      if (hits.length >= limit && rowsRemain) {
        full = true
        break walk
      }
      if (scanned >= scan.maxScanned && rowsRemain) break walk
    }
    if (!more) {
      exhausted = true
      break
    }
    position = lastScanned && positionOf(lastScanned)
  }

  const page = hits
  const people = new People(mirror, me)
  const entries = messageEntries(mirror, people, page, now)
  const refs = chatRefs(mirror, people, page)
  entries.forEach((entry, index) => {
    const ref = refs.get(page[index]!.chat)
    if (ref) entry.chat = ref
  })
  const { items, stopped } = fitItems((shown) => ({ messages: shown, note: DATA_NOTE }), entries, {
    cuttable: cuttableMessage,
  })
  const result: ChatReadOutput = { messages: items, note: DATA_NOTE }
  let next: Position | undefined
  if (stopped || full) next = positionOf(page[items.length - 1]!)
  else if (!exhausted && lastScanned) {
    next = positionOf(lastScanned)
    result.scanned_to = formatLocalTime(lastScanned.ts)
  }
  if (next) result.next = encodeCursor({ ...next, filter })
  return result
}
