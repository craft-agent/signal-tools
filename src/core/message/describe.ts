import { createHash } from "node:crypto"
import { readList } from "../chat/message-rows"
import { promptMentions } from "../chat/mentions"
import { People } from "../chat/people"
import type { Mirror } from "../signal/mirror"
import type { StoredMention } from "../signal/mirror-parts"
import type { CallFact, CallHeadline } from "../tool"
import { promptTime } from "../time"
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
  /** Values the prompt does not show that a write must find unchanged: a group's members (a hash of their ids, since the prompt shows only their count); empty for a person and for Note to Self. */
  pins: Record<string, string>
}

/** The pin of a group's members: a SHA-256 of their account ids, sorted, one per line. */
function membersPin(members: string[]): string {
  return createHash("sha256")
    .update([...members].sort().join("\n"))
    .digest("hex")
}

/** Reads what the description of a write to `prepared` says of its chat; the people of an excluded chat are never looked up. */
export function chatSubject(mirror: Mirror, prepared: ChatOfCall, excluded: ReadonlySet<string>): ChatSubject {
  const { chat, me, noteToSelf } = prepared
  const people = new People(mirror, me, excluded)
  const isGroup = chat.kind === "group"
  if (!noteToSelf && !isGroup) people.load([chat.id])

  let name: string | null = null
  if (isGroup) name = chat.name?.trim() ? chat.name : null
  else if (!noteToSelf) name = people.name(chat.id)

  let members: number | null = null
  let pins: Record<string, string> = {}
  if (isGroup) {
    const row = mirror.prepare("SELECT members FROM chats WHERE id = ?").get(chat.id) as
      { members: string | null } | undefined
    const ids = readList<string>(row?.members ?? null)
    members = ids.length
    pins = { members: membersPin(ids) }
  }
  return { prepared, name, members, people, pins }
}

/**
 * The headline of a write to a chat: `noteToSelf` for the user's own chat,
 * `template` with `{chat}` quoted for a named chat. A chat without a known name
 * gets `unnamed` (with `values` alone) when the call gives one, else none (the
 * intent stands in). `values` are the template's other values.
 */
export function chatHeadline(
  subject: ChatSubject,
  template: string,
  noteToSelf: string,
  values: Record<string, string> = {},
  unnamed?: string,
): CallHeadline | undefined {
  if (subject.prepared.noteToSelf) return { text: noteToSelf, ...(Object.keys(values).length > 0 && { values }) }
  if (subject.name === null) return unnamed === undefined ? undefined : { text: unnamed, values }
  return { text: template, values: { ...values, chat: subject.name } }
}

/** The templates for a reply's headline, according to whom it answers. */
export type ReplyHeadlines = {
  /** A known author in a named chat. */
  author: string
  /** The person of a person chat. */
  person: string
  /** The user's own message. */
  own: string
  /** An author without a known name. */
  unnamed: string
  /** A reply in the user's own chat. */
  noteToSelf: string
}

/** A reply's headline, naming whom it answers without numbers; none for a chat without a known name. Loads the author while the mirror is open. */
export function replyHeadline(
  subject: ChatSubject,
  quote: Quote,
  templates: ReplyHeadlines,
  values: Record<string, string> = {},
): CallHeadline | undefined {
  if (subject.prepared.noteToSelf)
    return { text: templates.noteToSelf, ...(Object.keys(values).length > 0 && { values }) }
  if (subject.name === null) return undefined
  const { people, prepared } = subject
  const chat = subject.name
  if (quote.author === people.me) return { text: templates.own, values: { ...values, chat } }
  if (prepared.chat.kind === "person" && quote.author === prepared.chat.id) {
    return { text: templates.person, values: { ...values, chat } }
  }
  people.load([quote.author])
  const name = people.name(quote.author)
  return name === null
    ? { text: templates.unnamed, values: { ...values, chat } }
    : { text: templates.author, values: { ...values, author: name, chat } }
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

/**
 * A fact holding the text of a message that already exists. An approval card
 * shows its text so the person knows which message, a disappearing message's
 * too. A view-once message has no text and was meant to be seen once, so its
 * value is a template saying so. Mentions use known names, never numbers.
 */
export function messageTextFact(
  subject: ChatSubject,
  label: string,
  message: { body: string | null; view_once: number; mentions: readonly StoredMention[] },
): CallFact {
  if (message.view_once) return { label, value: { text: MESSAGE_WORDS.viewOnce } }
  return writtenFact(label, mentionedText(subject, message.body, message.mentions))
}

/** Renders stored mentions with known names, never numbers. */
function mentionedText(subject: ChatSubject, body: string | null, mentions: readonly StoredMention[]): string | null {
  const { people } = subject
  people.load(mentions.flatMap(({ uuid }) => (uuid === undefined ? [] : [uuid])))
  return body === null ? null : promptMentions(body, mentions, people)
}

/** The `Reply to` fact: the pinned sent time, then the quoted text with named mentions, files, or a translated absence; none when the call quotes nothing. */
export function replyToFacts(subject: ChatSubject, quote: Quote | null): CallFact[] {
  if (!quote) return []
  return [{ label: MESSAGE_WORDS.replyTo, value: replyToValue(subject, quote) }]
}

/** The value of the `Reply to` fact: a value template led by the quoted message's sent time. */
function replyToValue(subject: ChatSubject, quote: Quote): CallFact["value"] {
  const time = promptTime(quote.timestamp)
  if (quote.viewOnce) return { text: MESSAGE_WORDS.replyViewOnce, values: { time } }
  const text = mentionedText(subject, quote.text, quote.textMentions ?? quote.mentions)
  const files = quote.files ?? []
  if (text?.trim()) return { text: MESSAGE_WORDS.replyText, values: { time, text } }
  if (files.length > 0 && files.every((name) => name !== null)) {
    return { text: MESSAGE_WORDS.replyFiles, values: { time, files: files.join(", ") } }
  }
  if (files.length > 0) {
    return {
      text: files.length === 1 ? MESSAGE_WORDS.replyFile : MESSAGE_WORDS.replyFilesCount,
      values: { time, count: files.length },
    }
  }
  return { text: MESSAGE_WORDS.replyNoText, values: { time } }
}

/**
 * The `From` fact: `you` (a value template, translated) for the user's own
 * message, the author's name (plain string) otherwise; none when the author has
 * no known name, and none when the author is the person of a person chat whose
 * name the headline already shows. Loads the author into the subject's `people`.
 */
export function authorFacts(subject: ChatSubject, author: string): CallFact[] {
  const { people, prepared } = subject
  if (author === people.me) return [{ label: MESSAGE_WORDS.from, value: { text: MESSAGE_WORDS.you } }]
  if (subject.name !== null && prepared.chat.kind === "person" && author === prepared.chat.id) return []
  people.load([author])
  const name = people.name(author)
  return name === null ? [] : [{ label: MESSAGE_WORDS.from, value: name }]
}
