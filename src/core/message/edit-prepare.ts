import { readJson } from "../chat/message-rows"
import { ToolError } from "../errors"
import type { Mirror } from "../signal/mirror"
import type { StoredQuote } from "../signal/mirror-parts"
import { MAX_EDITS } from "./constants"
import { findOwnMessage, type OwnMessage } from "./own"
import type { PreparedChat } from "./prepare"
import { quoteOfStored, type Quote } from "./quote"

/** What an edit needs from the mirror, read before anything is sent. */
export type PreparedEdit = {
  /** The message's sent time: the one Signal points at. */
  timestamp: number
  /** The message's current text (the latest edit). */
  body: string
  /** The message's disappearing timer in seconds, 0 for none; only the description reads it. */
  expiresIn: number
  /** The message's quote, to send again with the edit; null for a message that quotes nothing. */
  quote: Quote | null
  /** How many more edits Signal allows once this one is made. */
  editsLeft: number
}

/**
 * How many times a message was edited, from the versions the mirror keeps: its
 * latest edit, and every earlier version but the original. A message first
 * seen as an edit has no original to leave out.
 */
function editsMade(mirror: Mirror, author: string, message: OwnMessage): number {
  const earlier = mirror
    .prepare("SELECT COUNT(*) AS n FROM edits WHERE author = ? AND ts = ? AND rev_ts <> ?")
    .get(author, message.ts, message.ts) as { n: number }
  return earlier.n + (message.edited === null ? 0 : 1)
}

/**
 * Checks, in the mirror, that the user's message can be edited to `text`.
 * `invalid_argument` for a message that is not only text (view-once, files, a
 * sticker), a reply whose quote cannot be sent again and a text that changes
 * nothing; `forbidden` for one edited
 * `MAX_EDITS` times already. See `findOwnMessage` for the rest.
 */
export function prepareEdit(
  mirror: Mirror,
  { chat, me }: PreparedChat,
  reference: { author: string; ts: number },
  text: string,
  now: number,
): PreparedEdit {
  const message = findOwnMessage(mirror, chat.id, reference, me, now, "edit")
  if (message.view_once) throw new ToolError("invalid_argument", "A view-once message cannot be edited.")
  if (message.attachments !== null) {
    throw new ToolError("invalid_argument", "Only a message without files can be edited.")
  }
  if (message.body === null || message.sticker || message.other !== null) {
    throw new ToolError("invalid_argument", "Only a text message can be edited.")
  }
  const made = editsMade(mirror, me, message)
  if (made >= MAX_EDITS) {
    throw new ToolError("forbidden", `Signal allows a message to be edited ${MAX_EDITS} times, and this one was.`)
  }
  if (text === message.body) {
    throw new ToolError("invalid_argument", "The text is the message's current text; give the new text.")
  }
  const stored = readJson(message.quote) as StoredQuote | null
  const quote = quoteOfStored(stored)
  if (stored && !quote) {
    throw new ToolError(
      "invalid_argument",
      "This reply's quote cannot be sent again, so editing it would drop the quote.",
    )
  }
  return {
    timestamp: message.ts,
    body: message.body,
    expiresIn: message.expires_in,
    quote,
    editsLeft: MAX_EDITS - made - 1,
  }
}
