import { isRecord } from "./daemon-errors"
import { accountId } from "./ids"

/** An attachment of a message as the mirror keeps it (JSON in `messages.attachments`); absent fields are left out. */
export type StoredAttachment = {
  /** The file's name in signal-cli's directory of received attachments. */
  id?: string
  /** Its content type. */
  type?: string
  /** The name it was sent with. */
  name?: string
  size?: number
  caption?: string
  voice?: true
}

/** Who a mention names: an account id or a number, and where in the text it sits. */
export type StoredMention = {
  start: number
  uuid?: string
  number?: string
}

/** The message a message quotes (JSON in `messages.quote`); `author` is null when signal-cli gave no account id. */
export type StoredQuote = {
  id: number
  author: string | null
  text: string | null
  mentions?: StoredMention[]
}

/** The integer in `value`, or null. */
export function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

/** The text in `value` when it is a non-empty string, else null. */
export function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/** `value` as JSON, or null for nothing to store (null, or an empty list). */
export function toJson(value: unknown): string | null {
  if (value === null || (Array.isArray(value) && value.length === 0)) return null
  return JSON.stringify(value)
}

/** The list in `items`, or an empty one. */
function entries(items: unknown): unknown[] {
  return Array.isArray(items) ? items : []
}

/** signal-cli's attachments of a data message, reduced to what a read shows. */
export function readAttachments(items: unknown): StoredAttachment[] {
  const out: StoredAttachment[] = []
  for (const item of entries(items)) {
    if (!isRecord(item)) continue
    const entry: StoredAttachment = {}
    if (typeof item.id === "string") entry.id = item.id
    if (typeof item.contentType === "string") entry.type = item.contentType
    if (typeof item.filename === "string") entry.name = item.filename
    if (typeof item.size === "number") entry.size = item.size
    const caption = textOrNull(item.caption)
    if (caption) entry.caption = caption
    if (item.isVoiceNote) entry.voice = true
    out.push(entry)
  }
  return out
}

/** The file names of the attachments in a stored `attachments` column; a column that does not parse holds none. */
export function attachmentIds(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return entries(parsed).flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []))
  } catch {
    return []
  }
}

/** signal-cli's mentions (`{ number, uuid, start, length }`) in text order, naming an account id or a number only. */
export function readMentions(items: unknown): StoredMention[] {
  const out: StoredMention[] = []
  for (const item of entries(items)) {
    if (!isRecord(item)) continue
    const start = intOrNull(item.start)
    if (start === null) continue
    const mention: StoredMention = { start }
    const uuid = accountId(item.uuid)
    if (uuid) mention.uuid = uuid
    if (typeof item.number === "string") mention.number = item.number
    out.push(mention)
  }
  return out.sort((a, b) => a.start - b.start)
}

/** signal-cli's quote of a data message, or null when it names no message. */
export function readQuote(quote: unknown): StoredQuote | null {
  if (!isRecord(quote)) return null
  const id = intOrNull(quote.id)
  if (id === null) return null
  const stored: StoredQuote = {
    id,
    author: accountId(quote.authorUuid),
    text: typeof quote.text === "string" ? quote.text : null,
  }
  const mentions = readMentions(quote.mentions)
  if (mentions.length > 0) stored.mentions = mentions
  return stored
}
