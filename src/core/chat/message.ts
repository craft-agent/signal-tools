import { isRecord } from "../signal/daemon-errors"
import { messageId } from "../signal/ids"
import type { Mirror } from "../signal/mirror"
import type { StoredAttachment, StoredMention, StoredQuote } from "../signal/mirror-parts"
import { messageDisappearsAt } from "../signal/mirror-rows"
import { formatLocalTime } from "../time"
import { renderMentions } from "./mentions"
import { PRIVATE_NOTE, UNSUPPORTED_NOTE, type MessageEntry } from "./message-schema"
import { loadRelated, readJson, readList, type Related, type StoredMessage } from "./message-rows"
import { OWN_NAME, type People } from "./people"

/** A stored message with its JSON columns read. */
type Parsed = {
  row: StoredMessage
  files: StoredAttachment[]
  quote: StoredQuote | null
  mentions: StoredMention[]
}

function parse(row: StoredMessage): Parsed {
  const quote = readJson(row.quote)
  return {
    row,
    files: readList<StoredAttachment>(row.attachments),
    quote: isRecord(quote) ? (quote as StoredQuote) : null,
    mentions: readList<StoredMention>(row.mentions),
  }
}

/** Every account id a set of messages names: senders, quoted authors, mentioned people, reactors. */
function namedAccounts(parsed: readonly Parsed[], related: Related): string[] {
  const ids: string[] = []
  for (const { row, quote, mentions } of parsed) {
    ids.push(row.author)
    if (quote?.author) ids.push(quote.author)
    for (const mention of [...mentions, ...(quote?.mentions ?? [])]) if (mention.uuid) ids.push(mention.uuid)
  }
  for (const reactions of related.reactions.values()) for (const { reactor } of reactions) ids.push(reactor)
  for (const versions of related.versions.values()) {
    for (const { mentions } of versions)
      for (const mention of readList<StoredMention>(mentions)) if (mention.uuid) ids.push(mention.uuid)
  }
  return ids
}

/** The files of a message by name, type, size and caption; never the id signal-cli stored them under. */
function files(items: readonly StoredAttachment[]): NonNullable<MessageEntry["files"]> {
  return items.map((item) => {
    const file: NonNullable<MessageEntry["files"]>[number] = {}
    if (item.name !== undefined) file.name = item.name
    if (item.type !== undefined) file.type = item.type
    if (item.size !== undefined) file.size = item.size
    if (item.caption !== undefined) file.caption = item.caption
    if (item.voice) file.voice_note = true
    return file
  })
}

function reactions(related: Related, id: string, people: People): MessageEntry["reactions"] {
  const stored = related.reactions.get(id)
  return stored?.map(({ reactor, emoji }) =>
    reactor === people.me ? { from: OWN_NAME, emoji } : { from: people.who(reactor), from_id: reactor, emoji },
  )
}

function earlierVersions(related: Related, id: string, people: People): MessageEntry["earlier_versions"] {
  const stored = related.versions.get(id)
  return stored?.map(({ rev_ts, body, mentions }) => ({
    time: formatLocalTime(rev_ts),
    text: renderMentions(body ?? "", readList<StoredMention>(mentions), people),
  }))
}

function entryOf(
  { row, files: stored, quote, mentions }: Parsed,
  related: Related,
  people: People,
  now: number,
): MessageEntry {
  const id = messageId(row.author, row.ts)
  const entry: MessageEntry = {
    id,
    time: formatLocalTime(row.ts),
    from: row.from_me ? OWN_NAME : people.who(row.author, row.author_name),
  }
  if (!row.from_me) entry.from_id = row.author
  if (row.kind === "timer") {
    entry.timer_set_seconds = row.expires_in
    return entry
  }
  if (row.body) entry.text = renderMentions(row.body, mentions, people)
  if (stored.length > 0) entry.files = files(stored)
  if (row.sticker) entry.sticker = true
  if (row.view_once) entry.view_once = true
  if (row.other) {
    entry.unsupported = row.other
    entry.unsupported_note = UNSUPPORTED_NOTE
  }
  if (quote) {
    entry.reply_to = {
      id: quote.author ? messageId(quote.author, quote.id) : null,
      text: quote.text === null ? null : renderMentions(quote.text, quote.mentions ?? [], people),
    }
  }
  if (row.edited !== null) entry.edited_at = formatLocalTime(row.edited)
  const versions = earlierVersions(related, id, people)
  if (versions) entry.earlier_versions = versions
  const reacted = reactions(related, id, people)
  if (reacted) entry.reactions = reacted
  if (row.expires_in > 0) {
    entry.disappears_after_seconds = row.expires_in
    const disappearsAt = messageDisappearsAt(row)
    if (disappearsAt !== null) {
      entry.disappears_at = formatLocalTime(disappearsAt)
      if (disappearsAt <= now) entry.expired = true
    }
  }
  if (row.expires_in > 0 || row.view_once) entry.private_note = PRIVATE_NOTE
  return entry
}

/**
 * The entries for stored messages, in the order given. Names, reactions and
 * earlier versions for all of them are read in a few queries. `now` decides
 * which disappearing messages have expired.
 */
export function messageEntries(
  mirror: Mirror,
  people: People,
  rows: readonly StoredMessage[],
  now: number,
): MessageEntry[] {
  const parsed = rows.map(parse)
  const related = loadRelated(mirror, rows)
  people.load(namedAccounts(parsed, related))
  return parsed.map((item) => entryOf(item, related, people, now))
}
