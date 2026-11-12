import { readList } from "../chat/message-rows"
import type { Mirror } from "../signal/mirror"
import type { StoredAttachment, StoredMention, StoredQuote } from "../signal/mirror-parts"
import { findLiveRow } from "./lookup"

/** A mention sits at one placeholder character of the quoted text. */
const QUOTED_MENTION_LENGTH = 1

/** What separates a quoted file's type, name and preview path in signal-cli's `quoteAttachment`. */
const QUOTED_ATTACHMENT_SEPARATOR = ":"

/** Whether `part` can go into a `quoteAttachment` as one part: not empty, and not holding the separator. */
function isQuotablePart(part: string | undefined): part is string {
  return !!part && !part.includes(QUOTED_ATTACHMENT_SEPARATOR)
}

/** The content type and optional name of a file, as Signal's clients quote it. */
export type QuotedAttachment = { type: string; name?: string }

/** The message a reply quotes, as the mirror has it now. */
export type Quote = {
  /** The quoted message's sent time: the one Signal points at. */
  timestamp: number
  /** The quoted message's author, by account id. */
  author: string
  /** Its current text (the latest edit) with mentions as placeholders; null for a message without text. */
  text: string | null
  /** The mentions of that text that name someone. */
  mentions: StoredMention[]
  /** The quoted message's first file, by content type and name, as Signal's clients quote it; absent when it has none or its type is unknown. */
  attachment?: QuotedAttachment
  /** Whether the quoted message is view-once (1) or not (0); only the description of the call reads it, `quoteParams` ignores it. */
  viewOnce?: number
  /** The quoted files' trimmed sent names, null when unknown; only the description reads them, `quoteParams` ignores them. */
  files?: (string | null)[]
  /** Every mention of that text, those that name nobody included; only the description reads them, `quoteParams` ignores them. */
  textMentions?: StoredMention[]
}

/** The mentions that name someone, as a quote carries them. */
function namedMentions(mentions: StoredMention[]): StoredMention[] {
  return mentions.filter((mention) => mention.uuid ?? mention.number)
}

/** The first file's type and usable name, without a preview file for signal-cli to upload. */
export function quotedAttachment(attachments: StoredAttachment[]): QuotedAttachment | undefined {
  const first = attachments[0]
  if (!isQuotablePart(first?.type)) return undefined
  return { type: first.type, ...(isQuotablePart(first.name) ? { name: first.name } : {}) }
}

/**
 * The message a reply quotes, for a reply to quote it again. Null when the
 * stored quote names no author, which signal-cli cannot quote without.
 */
export function quoteOfStored(stored: StoredQuote | null): Quote | null {
  if (!stored || stored.author === null) return null
  return {
    timestamp: stored.id,
    author: stored.author,
    text: stored.text,
    mentions: namedMentions(stored.mentions ?? []),
  }
}

/** The arguments that make the message a reply: the quoted message's time, author, text, mentions and first file. */
export function quoteParams(quote: Quote): Record<string, unknown> {
  const mentions = quote.mentions.map(
    (mention) => `${mention.start}:${QUOTED_MENTION_LENGTH}:${mention.uuid ?? mention.number}`,
  )
  return {
    quoteTimestamp: quote.timestamp,
    quoteAuthor: quote.author,
    ...(quote.text ? { quoteMessage: quote.text } : {}),
    ...(mentions.length > 0 ? { quoteMention: mentions } : {}),
    ...(quote.attachment
      ? {
          quoteAttachment: [
            [quote.attachment.type, quote.attachment.name].filter(Boolean).join(QUOTED_ATTACHMENT_SEPARATOR),
          ],
        }
      : {}),
  }
}

/**
 * The message of `chat` that `reference` names, for a reply to quote. A
 * message of another chat, an unknown one and a timer change are `not_found`
 * alike; so is one deleted for everyone or expired, saying it is gone.
 */
export function findQuote(mirror: Mirror, chat: string, reference: { author: string; ts: number }, now: number): Quote {
  const row = findLiveRow<{
    body: string | null
    mentions: string | null
    view_once: number
    attachments: string | null
  }>(mirror, chat, reference, "body, mentions, view_once, attachments", now)
  const textMentions = readList<StoredMention>(row.mentions)
  const attachments = readList<StoredAttachment>(row.attachments)
  return {
    timestamp: reference.ts,
    author: reference.author,
    text: row.body,
    mentions: namedMentions(textMentions),
    attachment: quotedAttachment(attachments),
    viewOnce: row.view_once,
    files: attachments.map(({ name }) => name?.trim() || null),
    textMentions,
  }
}
