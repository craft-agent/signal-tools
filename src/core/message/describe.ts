import { readList } from "../chat/message-rows"
import { People } from "../chat/people"
import type { Mirror } from "../signal/mirror"
import type { CallFact, CallHeadline } from "../tool"
import type { PreparedChat } from "./prepare"
import type { Quote } from "./quote"
import { MESSAGE_WORDS } from "./words"

/** The chat a call writes to or reads from: a `PreparedChat`, or a chat a call may use without being a member, whose user may not be known yet. */
export type ChatOfCall = Omit<PreparedChat, "me"> & { me: string | null }

/** What the description of a write to a chat says of the chat, read from the mirror. */
export type ChatSubject = {
  prepared: ChatOfCall
  /** The chat's name as the mirror has it, never a number: a group's title, a person's name; null for Note to Self and when none is known. */
  name: string | null
  /** How many members a group has, the user included, as the mirror lists them; null for a person. */
  members: number | null
  /** The People of the chat, loaded with the chat's person (for `authorFacts`). */
  people: People
}

/** Reads what the description of a write to `prepared` says of its chat. */
export function chatSubject(mirror: Mirror, prepared: ChatOfCall): ChatSubject {
  const { chat, me, noteToSelf } = prepared
  const people = new People(mirror, me)
  const isGroup = chat.kind === "group"
  if (!noteToSelf && !isGroup) people.load([chat.id])

  let name: string | null = null
  if (isGroup) name = chat.name?.trim() ? chat.name : null
  else if (!noteToSelf) name = people.name(chat.id)

  let members: number | null = null
  if (isGroup) {
    const row = mirror.prepare("SELECT members FROM chats WHERE id = ?").get(chat.id) as
      { members: string | null } | undefined
    members = readList(row?.members ?? null).length
  }
  return { prepared, name, members, people }
}

/** The headline of a write to a chat: `noteToSelf` for the user's own chat, `template` with `{chat}` quoted for a named chat, none for a chat without a known name (the intent stands in). `values` are the template's other values. */
export function chatHeadline(
  subject: ChatSubject,
  template: string,
  noteToSelf: string,
  values: Record<string, string> = {},
): CallHeadline | undefined {
  if (subject.prepared.noteToSelf) return { text: noteToSelf, ...(Object.keys(values).length > 0 && { values }) }
  if (subject.name === null) return undefined
  return { text: template, values: { ...values, chat: subject.name } }
}

/** The `Chat` fact (`Person` or `Group`, value templates without placeholders so they translate); none for Note to Self, whose headline says it. */
export function chatFacts(subject: ChatSubject): CallFact[] {
  if (subject.prepared.noteToSelf) return []
  const kind = subject.prepared.chat.kind === "group" ? MESSAGE_WORDS.group : MESSAGE_WORDS.person
  return [{ label: MESSAGE_WORDS.chat, value: { text: kind } }]
}

/** The `Members` fact of a group (`{count} member` for one, else `{count} members`, count as a number value); none for a person. */
export function membersFacts(subject: ChatSubject): CallFact[] {
  const { members } = subject
  if (members === null) return []
  const text = members === 1 ? MESSAGE_WORDS.member : MESSAGE_WORDS.membersCount
  return [{ label: MESSAGE_WORDS.members, value: { text, values: { count: members } } }]
}

/** The `Files` fact: how many files a call carries or saves (`{count} file` for one); none for none. */
export function filesFacts(count: number): CallFact[] {
  if (count === 0) return []
  const text = count === 1 ? MESSAGE_WORDS.file : MESSAGE_WORDS.filesCount
  return [{ label: MESSAGE_WORDS.files, value: { text, values: { count } } }]
}

/** A fact holding text a person wrote, as it is (a plain string, never translated), or the `(no text)` value template when the message has none or only blank text. */
export function writtenFact(label: string, text: string | null): CallFact {
  return { label, value: text?.trim() ? text : { text: MESSAGE_WORDS.noText } }
}

/** The `Reply to` fact: the quoted message's text as `writtenFact` shows it; none when the call quotes nothing. */
export function replyToFacts(quote: Quote | null): CallFact[] {
  return quote ? [writtenFact(MESSAGE_WORDS.replyTo, quote.text)] : []
}

/** The `From` fact: `you` (a value template, translated) for the user's own message, the author's name (plain string) otherwise; none when the author has no known name. Loads the author into `people`. */
export function authorFacts(people: People, author: string): CallFact[] {
  if (author === people.me) return [{ label: MESSAGE_WORDS.from, value: { text: MESSAGE_WORDS.you } }]
  people.load([author])
  const name = people.name(author)
  return name === null ? [] : [{ label: MESSAGE_WORDS.from, value: name }]
}
