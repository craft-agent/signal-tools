import { isGroupChat } from "./ids"
import type { Mirror } from "./mirror"

/** The columns of a stored message that editing, reacting and deleting need. */
export type MessageRow = {
  chat: string
  author: string
  ts: number
  body: string | null
  attachments: string | null
  mentions: string | null
  edited: number | null
}

const MESSAGE_COLUMNS = "chat, author, ts, body, attachments, mentions, edited"

/**
 * Records that a chat has a message at `ts`, creating the chat when new; a
 * known chat keeps its name and number and only moves its latest time forward.
 */
export function touchChat(mirror: Mirror, chat: string, ts: number, now: number, number: string | null = null): void {
  mirror
    .prepare(
      `INSERT INTO chats (id, kind, number, last_ts, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         last_ts = MAX(COALESCE(chats.last_ts, 0), excluded.last_ts),
         number = COALESCE(chats.number, excluded.number)`,
    )
    .run(chat, isGroupChat(chat) ? "group" : "person", number, ts, now)
}

/** The account id a contact with this number was last seen with, or null. */
export function contactUuid(mirror: Mirror, number: unknown): string | null {
  if (typeof number !== "string" || number === "") return null
  const row = mirror.prepare("SELECT uuid FROM contacts WHERE number = ? ORDER BY updated DESC LIMIT 1").get(number) as
    { uuid: string } | undefined
  return row?.uuid ?? null
}

/** Whether the mirror was told that this message (or revision) of `author` was deleted for everyone. */
export function isDeleted(mirror: Mirror, author: string, ts: number): boolean {
  return mirror.prepare("SELECT 1 FROM deleted WHERE author = ? AND ts = ?").get(author, ts) !== undefined
}

/** Records the times of a message deleted for everyone, so that nothing of it is stored if it arrives later. */
export function recordDeleted(mirror: Mirror, author: string, times: Iterable<number>, now: number): void {
  const insert = mirror.prepare("INSERT OR IGNORE INTO deleted (author, ts, at) VALUES (?, ?, ?)")
  for (const ts of times) insert.run(author, ts, now)
}

/** A message by its author and time, also when `ts` names one of its later revisions. */
export function findMessage(mirror: Mirror, author: string, ts: number): MessageRow | null {
  const bySelect = (where: string, value: number) =>
    mirror.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE author = ? AND ${where}`).get(author, value) as
      MessageRow | undefined
  const direct = bySelect("ts = ?", ts) ?? bySelect("edited = ?", ts)
  if (direct) return direct
  const revision = mirror.prepare("SELECT ts FROM edits WHERE author = ? AND rev_ts = ?").get(author, ts) as
    { ts: number } | undefined
  return revision ? (bySelect("ts = ?", revision.ts) ?? null) : null
}
