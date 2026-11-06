import { cutText } from "../pages"
import type { Mirror } from "../signal/mirror"
import type { People } from "./people"

/** What a chat with oneself is called. */
export const NOTE_TO_SELF = "Note to Self"

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

/** The account ids whose names naming `chats` takes: the person chats. */
export function personIds(chats: readonly StoredChat[]): string[] {
  return chats.filter((chat) => chat.kind === "person").map((chat) => chat.id)
}

/**
 * A chat's name: Note to Self for the user's own, a group's title, a person's
 * display name. Null when none is known. The people of the chat must be loaded.
 */
export function chatName(chat: StoredChat, people: People): string | null {
  if (chat.id === people.me) return NOTE_TO_SELF
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

/** A person's number when known; never the user's own, whose chat is Note to Self. */
export function chatNumber(chat: StoredChat, people: People): string | null {
  if (chat.kind !== "person" || chat.id === people.me) return null
  const number = people.number(chat.id) ?? chat.number
  return number !== null && !people.isOwnNumber(number) ? number : null
}
