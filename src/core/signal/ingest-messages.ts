import { isRecord } from "./daemon-errors"
import { GROUP_ID_PATTERN, accountId, groupChat } from "./ids"
import type { IngestContext, IngestResult } from "./ingest-context"
import { deleteMessage } from "./ingest-delete"
import { GROUPS_STALE_META } from "./mirror-meta"
import { setMeta, type Mirror } from "./mirror"
import { findMessage, isDeleted, touchChat } from "./mirror-rows"
import { intOrNull, readAttachments, readMentions, readQuote, textOrNull, toJson } from "./mirror-parts"

/** The data message fields that mark a kind the mirror does not read further; the first one present is kept as `other`. */
const OTHER_KINDS = ["pollCreate", "contacts", "payment", "pollVote", "pollTerminate", "pinMessage"] as const

/** Who sent a data message, and in which chat it landed. */
export type Sender = {
  chat: string
  author: string
  fromMe: boolean
  /** The name the sender gave, for an incoming message. */
  authorName: string | null
}

/**
 * The group a data message belongs to, as its chat id: from the first of
 * `datas` that names one. `null` when the group id is malformed, `undefined`
 * when none names a group.
 */
export function groupChatOf(...datas: unknown[]): string | null | undefined {
  for (const data of datas) {
    const info = isRecord(data) ? data.groupInfo : undefined
    const id = isRecord(info) ? info.groupId : undefined
    if (id === undefined || id === null) continue
    return typeof id === "string" && GROUP_ID_PATTERN.test(id) ? groupChat(id) : null
  }
  return undefined
}

/** Whether `items` is a list with something in it. */
function hasItems(items: unknown): boolean {
  return Array.isArray(items) && items.length > 0
}

/** The time of the latest message of `chat`, or null when the mirror has none of it. */
function latestTs(mirror: Mirror, chat: string): number | null {
  const row = mirror.prepare("SELECT last_ts FROM chats WHERE id = ?").get(chat) as
    { last_ts: number | null } | undefined
  return row?.last_ts ?? null
}

/** Sets the disappearing-message timer of `chat` to `seconds`. */
function setChatTimer(mirror: Mirror, chat: string, seconds: number): void {
  mirror.prepare("UPDATE chats SET expires_in = ? WHERE id = ?").run(seconds, chat)
}

/**
 * Stores one data message (incoming or a sent transcript). Returns what it
 * was, "dropped-deleted" when it was deleted for everyone before it arrived,
 * or null when there was nothing to keep. `edited` is the time of the edit
 * that this message's text comes from, when its original was never seen.
 *
 * A message that carries a timer and is not older than the chat's latest sets
 * the chat's timer, 0 included, since every message carries the chat's
 * current one; a message ingested late leaves a newer timer alone, and so
 * does an edit, which says nothing of the chat's timer at its own time.
 */
export function storeMessage(
  mirror: Mirror,
  ctx: IngestContext,
  sender: Sender,
  data: Record<string, unknown>,
  edited: number | null = null,
): "message" | "timer" | "dropped-deleted" | null {
  const ts = intOrNull(data.timestamp)
  if (ts === null) return null
  const { chat, author, fromMe, authorName } = sender
  if (isDeleted(mirror, author, ts)) return "dropped-deleted"
  const timer = intOrNull(data.expiresInSeconds)
  const expires = timer ?? 0
  if (data.isExpirationUpdate) {
    touchChat(mirror, chat, ts, ctx.now)
    setChatTimer(mirror, chat, expires)
    mirror
      .prepare(
        `INSERT OR IGNORE INTO messages (chat, author, ts, from_me, author_name, kind, expires_in, received)
         VALUES (?, ?, ?, ?, ?, 'timer', ?, ?)`,
      )
      .run(chat, author, ts, Number(fromMe), authorName, expires, ctx.now)
    return "timer"
  }
  const body = textOrNull(data.message)
  const attachments = readAttachments(data.attachments)
  const sticker = isRecord(data.sticker)
  const other = OTHER_KINDS.find((kind) => data[kind]) ?? null
  if (!body && attachments.length === 0 && !sticker && !other) return null
  const latest = latestTs(mirror, chat)
  touchChat(mirror, chat, ts, ctx.now)
  if (timer !== null && edited === null && (latest === null || ts >= latest)) setChatTimer(mirror, chat, timer)
  mirror
    .prepare(
      `INSERT INTO messages (chat, author, ts, from_me, author_name, body, attachments, quote, sticker, other,
         expires_in, expire_start, view_once, edited, received, mentions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (author, ts) DO NOTHING`,
    )
    .run(
      chat,
      author,
      ts,
      Number(fromMe),
      authorName,
      body,
      toJson(attachments),
      toJson(readQuote(data.quote)),
      Number(sticker),
      other,
      expires,
      fromMe && expires > 0 ? ts : null,
      Number(Boolean(data.viewOnce)),
      edited,
      ctx.now,
      toJson(readMentions(data.mentions)),
    )
  return "message"
}

/** A reaction by `reactor` to a message: added, replacing their earlier one, or removed. Dropped when the message was deleted. */
function react(
  mirror: Mirror,
  ctx: IngestContext,
  reactor: string,
  reaction: Record<string, unknown>,
): "reaction" | "dropped-deleted" | null {
  const author = accountId(reaction.targetAuthorUuid)
  const target = intOrNull(reaction.targetSentTimestamp)
  if (!author || target === null) return null
  if (isDeleted(mirror, author, target)) return "dropped-deleted"
  const ts = findMessage(mirror, author, target)?.ts ?? target
  if (reaction.isRemove) {
    mirror.prepare("DELETE FROM reactions WHERE author = ? AND ts = ? AND reactor = ?").run(author, ts, reactor)
    return "reaction"
  }
  const emoji = textOrNull(reaction.emoji)
  if (!emoji) return null
  mirror
    .prepare(
      `INSERT INTO reactions (author, ts, reactor, emoji, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (author, ts, reactor) DO UPDATE SET emoji = excluded.emoji, at = excluded.at`,
    )
    .run(author, ts, reactor, emoji, ctx.now)
  return "reaction"
}

/**
 * Applies one data message of `sender` (incoming, or a sent transcript):
 * a delete for everyone, a reaction, a group update, or a message to store.
 * Returns what it did, and the files of a deleted message for the caller to
 * remove after the transaction commits.
 */
export function applyDataMessage(
  mirror: Mirror,
  ctx: IngestContext,
  sender: Sender,
  data: Record<string, unknown>,
): IngestResult {
  const result: IngestResult = { done: [], removeFiles: [] }
  if (isRecord(data.remoteDelete)) {
    const target = intOrNull(data.remoteDelete.timestamp)
    const files = target === null ? null : deleteMessage(mirror, ctx, sender.author, target)
    if (target !== null) result.done.push(files ? "delete" : "delete-early")
    if (files) result.removeFiles.push(...files)
  } else if (isRecord(data.reaction)) {
    const done = react(mirror, ctx, sender.author, data.reaction)
    if (done) result.done.push(done)
  } else if (
    isRecord(data.groupInfo) &&
    data.groupInfo.type === "UPDATE" &&
    !data.message &&
    !hasItems(data.attachments)
  ) {
    setMeta(mirror, { [GROUPS_STALE_META]: 1 })
    result.done.push("group-update")
  } else {
    const done = storeMessage(mirror, ctx, sender, data)
    if (done) result.done.push(done)
  }
  return result
}
