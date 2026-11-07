import { readList } from "../chat/message-rows"
import type { Mirror } from "../signal/mirror"
import type { StoredMention, StoredQuote } from "../signal/mirror-parts"
import { findLiveRow } from "./lookup"

/** A mention sits at one placeholder character of the quoted text. */
const QUOTED_MENTION_LENGTH = 1

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
}

/** The mentions that name someone, as a quote carries them. */
function namedMentions(mentions: StoredMention[]): StoredMention[] {
  return mentions.filter((mention) => mention.uuid ?? mention.number)
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

/** The arguments that make the message a reply: the quoted message's time, author, text and mentions. */
export function quoteParams(quote: Quote): Record<string, unknown> {
  const mentions = quote.mentions.map(
    (mention) => `${mention.start}:${QUOTED_MENTION_LENGTH}:${mention.uuid ?? mention.number}`,
  )
  return {
    quoteTimestamp: quote.timestamp,
    quoteAuthor: quote.author,
    ...(quote.text ? { quoteMessage: quote.text } : {}),
    ...(mentions.length > 0 ? { quoteMention: mentions } : {}),
  }
}

/**
 * The message of `chat` that `reference` names, for a reply to quote. A
 * message of another chat, an unknown one and a timer change are `not_found`
 * alike; so is one deleted for everyone or expired, saying it is gone.
 */
export function findQuote(mirror: Mirror, chat: string, reference: { author: string; ts: number }, now: number): Quote {
  const row = findLiveRow<{ body: string | null; mentions: string | null }>(
    mirror,
    chat,
    reference,
    "body, mentions",
    now,
  )
  return {
    timestamp: reference.ts,
    author: reference.author,
    text: row.body,
    mentions: namedMentions(readList<StoredMention>(row.mentions)),
  }
}
