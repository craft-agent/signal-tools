import { readList } from "../chat/message-rows"
import { ToolError } from "../errors"
import type { Mirror } from "../signal/mirror"
import type { StoredMention } from "../signal/mirror-parts"
import { hasDisappeared, isDeleted } from "../signal/mirror-rows"

const GONE_MESSAGE = "That message is gone; it was deleted or has disappeared."
const UNKNOWN_MESSAGE = "No message with this id in this chat."

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

type QuotedRow = {
  kind: "message" | "timer"
  body: string | null
  mentions: string | null
  expires_in: number
  expire_start: number | null
}

/**
 * The message of `chat` that `reference` names, for a reply to quote. A
 * message of another chat, an unknown one and a timer change are `not_found`
 * alike; so is one deleted for everyone or expired, saying it is gone.
 */
export function findQuote(mirror: Mirror, chat: string, reference: { author: string; ts: number }, now: number): Quote {
  const row = mirror
    .prepare(
      "SELECT kind, body, mentions, expires_in, expire_start FROM messages WHERE chat = ? AND author = ? AND ts = ?",
    )
    .get(chat, reference.author, reference.ts) as QuotedRow | undefined
  if (!row || row.kind === "timer") {
    throw new ToolError("not_found", isDeleted(mirror, reference.author, reference.ts) ? GONE_MESSAGE : UNKNOWN_MESSAGE)
  }
  if (hasDisappeared(row, now)) throw new ToolError("not_found", GONE_MESSAGE)
  return {
    timestamp: reference.ts,
    author: reference.author,
    text: row.body,
    mentions: readList<StoredMention>(row.mentions).filter((mention) => mention.uuid ?? mention.number),
  }
}
