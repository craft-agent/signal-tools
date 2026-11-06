import { messageId } from "../signal/ids"
import type { Mirror } from "../signal/mirror"
import { placeholders } from "./sql"

/** The columns of `messages` that a message entry is built from. */
export const MESSAGE_COLUMNS =
  "chat, author, ts, from_me, author_name, kind, body, attachments, quote, sticker, other, expires_in, expire_start, view_once, edited, mentions"

/** A stored message as `MESSAGE_COLUMNS` selects it. */
export type StoredMessage = {
  chat: string
  author: string
  ts: number
  from_me: number
  author_name: string | null
  kind: "message" | "timer"
  body: string | null
  attachments: string | null
  quote: string | null
  sticker: number
  other: string | null
  expires_in: number
  expire_start: number | null
  view_once: number
  edited: number | null
  mentions: string | null
}

/** A JSON column, read; null when it is empty or does not parse. */
export function readJson(json: string | null): unknown {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** A JSON column that holds a list; an empty one when it holds anything else. */
export function readList<T>(json: string | null): T[] {
  const value = readJson(json)
  return Array.isArray(value) ? (value as T[]) : []
}

/** One reaction to a message. */
export type StoredReaction = { reactor: string; emoji: string }

/** One earlier version of an edited message, from the time it was written. */
export type StoredVersion = { rev_ts: number; body: string | null; mentions: string | null }

/** The reactions and earlier versions of a set of messages, by message id. */
export type Related = {
  reactions: Map<string, StoredReaction[]>
  versions: Map<string, StoredVersion[]>
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/**
 * Reads the reactions and earlier versions of `rows` in two queries, by the
 * authors and the span of times the rows cover, and keeps those of the rows
 * themselves.
 */
export function loadRelated(mirror: Mirror, rows: readonly StoredMessage[]): Related {
  const related: Related = { reactions: new Map(), versions: new Map() }
  const messages = rows.filter((row) => row.kind === "message")
  if (messages.length === 0) return related
  const wanted = new Set(messages.map((row) => messageId(row.author, row.ts)))
  const authors = [...new Set(messages.map((row) => row.author))]
  const times = messages.map((row) => row.ts)
  const params = [...authors, Math.min(...times), Math.max(...times)]
  const where = `author IN (${placeholders(authors.length)}) AND ts BETWEEN ? AND ?`
  const reactions = mirror
    .prepare(`SELECT author, ts, reactor, emoji FROM reactions WHERE ${where} ORDER BY at, reactor`)
    .all(...params) as (StoredReaction & { author: string; ts: number })[]
  for (const row of reactions) {
    const id = messageId(row.author, row.ts)
    if (wanted.has(id)) push(related.reactions, id, { reactor: row.reactor, emoji: row.emoji })
  }
  const versions = mirror
    .prepare(`SELECT author, ts, rev_ts, body, mentions FROM edits WHERE ${where} ORDER BY rev_ts`)
    .all(...params) as (StoredVersion & { author: string; ts: number })[]
  for (const row of versions) {
    const id = messageId(row.author, row.ts)
    if (wanted.has(id)) push(related.versions, id, { rev_ts: row.rev_ts, body: row.body, mentions: row.mentions })
  }
  return related
}
