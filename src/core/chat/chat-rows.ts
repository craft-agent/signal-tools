import { ToolError } from "../errors"
import { cutText } from "../pages"
import { isChatId } from "../signal/ids"
import type { Mirror } from "../signal/mirror"
import type { ChatRef } from "./message-schema"
import type { People } from "./people"
import { placeholders } from "./sql"

/** What a chat with oneself is called. */
export const NOTE_TO_SELF = "Note to Self"

/** Whether a chat is the user's own (Note to Self). */
export function isNoteToSelf(chatId: string, me: string | null): boolean {
  return me !== null && chatId === me
}

/** Whether a group chat is one the user is no longer a member of. */
export function isLeftGroup(chat: StoredChat): boolean {
  return chat.kind === "group" && !chat.member
}

/** A stored chat as `CHAT_COLUMNS` selects it. */
export type StoredChat = {
  id: string
  kind: "person" | "group"
  name: string | null
  number: string | null
  member: number
  expires_in: number | null
  last_ts: number | null
}

/** The columns of `chats` that a chat entry is built from. */
export const CHAT_COLUMNS = "id, kind, name, number, member, expires_in, last_ts"

/** Reads one chat by id; null when this mirror has none. */
export function findChat(mirror: Mirror, id: string): StoredChat | null {
  const row = mirror.prepare(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id = ?`).get(id) as StoredChat | undefined
  return row ?? null
}

/**
 * The user's own chat as it stands before its first message: no row yet, no
 * activity. The first message stored creates the row.
 */
export function ownChat(me: string): StoredChat {
  return { id: me, kind: "person", name: null, number: null, member: 1, expires_in: null, last_ts: null }
}

/** `chat` as a method's argument: a chat id, else `invalid_argument` (a name or number is never a chat). */
export function chatIdArgument(chat: string, method: string): string {
  if (!isChatId(chat)) {
    throw new ToolError(
      "invalid_argument",
      `chat must be a chat id (a person's account id, or group:<id>) from list; a name or number is not accepted by ${method}.`,
    )
  }
  return chat
}

/** `chat` as a required argument: its validated id, or `invalid_argument` when missing or not a chat id. */
export function requireChatId(chat: string | undefined, method: string): string {
  if (chat === undefined) {
    throw new ToolError("invalid_argument", `chat is required for ${method}: pass a chat id from list.`)
  }
  return chatIdArgument(chat, method)
}

/** The error for a chat this account's mirror does not have; an excluded chat is refused with the same one. */
export function unknownChat(): ToolError {
  return new ToolError("not_found", "No chat with this id in this account's mirror.")
}

/** The chat with this id, or `not_found` when this mirror has none; the user's own `me` always exists. */
export function existingChat(mirror: Mirror, me: string | null, id: string): StoredChat {
  const chat = findChat(mirror, id) ?? (isNoteToSelf(id, me) ? ownChat(id) : null)
  if (!chat) throw unknownChat()
  return chat
}

/** A chat id argument that must be present, valid and in this account's mirror (see `existingChat`). */
export function requireChat(mirror: Mirror, me: string | null, chat: string | undefined, method: string): StoredChat {
  return existingChat(mirror, me, requireChatId(chat, method))
}

/** `chat` as an optional argument: its stored row, or undefined when absent. */
export function optionalChat(
  mirror: Mirror,
  me: string | null,
  chat: string | undefined,
  method: string,
): StoredChat | undefined {
  return chat === undefined ? undefined : existingChat(mirror, me, chatIdArgument(chat, method))
}

/** The chats with these ids that this mirror has, by id. */
export function findChats(mirror: Mirror, ids: readonly string[]): Map<string, StoredChat> {
  if (ids.length === 0) return new Map()
  const rows = mirror
    .prepare(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id IN (${placeholders(ids.length)})`)
    .all(...ids) as StoredChat[]
  return new Map(rows.map((row) => [row.id, row]))
}

/** The account ids whose names naming `chats` takes: the person chats. */
export function personIds(chats: readonly StoredChat[]): string[] {
  return chats.filter((chat) => chat.kind === "person").map((chat) => chat.id)
}

/**
 * A chat's name: Note to Self for the user's own, a group's title, a person's
 * display name. Null when none is known. The people of the chat must be loaded.
 */
export function chatName(chat: StoredChat, people: People): string | null {
  if (isNoteToSelf(chat.id, people.me)) return NOTE_TO_SELF
  if (chat.kind === "group") return chat.name
  return people.displayName(chat.id, chat.number)
}

/** The most characters of a chat's name a result carries; a longer title is cut and says so. */
export const MAX_NAME_LENGTH = 1000

/** A chat's name as a result carries it: cut to `MAX_NAME_LENGTH` characters, with `name_cut` set when it was. */
export function shownName(name: string | null): { name: string | null; name_cut?: true } {
  if (name === null || name.length <= MAX_NAME_LENGTH) return { name }
  return { name: cutText(name, MAX_NAME_LENGTH), name_cut: true }
}

/** A chat reference header as returned in `chat` or on messages. */
export function chatHeader(chat: StoredChat, people: People): ChatRef {
  return { id: chat.id, kind: chat.kind, ...shownName(chatName(chat, people)) }
}

/** A person's number when known; never the user's own, whose chat is Note to Self. */
export function chatNumber(chat: StoredChat, people: People): string | null {
  if (chat.kind !== "person" || isNoteToSelf(chat.id, people.me)) return null
  const number = people.number(chat.id) ?? chat.number
  return number !== null && !people.isOwnNumber(number) ? number : null
}
