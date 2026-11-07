import { isLeftGroup, isNoteToSelf, requireChat, type StoredChat } from "../chat/chat-rows"
import { ToolError } from "../errors"
import type { Mirror } from "../signal/mirror"
import { findQuote, type Quote } from "./quote"

const LEFT_GROUP_MESSAGE = "You left this group; you can no longer send to it."
const OWN_ACCOUNT_UNKNOWN_MESSAGE =
  "This account's mirror does not know the account's own id yet; start its sync service."

/** What any write to a chat needs from the mirror, read before anything goes out. */
export type PreparedChat = {
  chat: StoredChat
  /** The user's own account id: the author of the message. */
  me: string
  /** Whether the chat is the user's own, which Signal addresses differently. */
  noteToSelf: boolean
}

/** What a send needs from the mirror, read before anything is sent. */
export type PreparedSend = PreparedChat & {
  quote: Quote | null
}

/**
 * Checks, in the mirror, that the chat can be written to by the tool `method`
 * names. `not_found` for a chat the mirror does not have, `forbidden` for a
 * group the user left.
 */
export function prepareChat(mirror: Mirror, me: string | null, chatId: string, method: string): PreparedChat {
  const chat = requireChat(mirror, chatId, method)
  if (isLeftGroup(chat)) throw new ToolError("forbidden", LEFT_GROUP_MESSAGE)
  if (me === null) throw new ToolError("upstream_error", OWN_ACCOUNT_UNKNOWN_MESSAGE)
  return { chat, me, noteToSelf: isNoteToSelf(chat.id, me) }
}

/**
 * Checks, in the mirror, that the chat can be sent to and the message to
 * reply to can be quoted. `not_found` for a chat or message the mirror does
 * not have, `forbidden` for a group the user left.
 */
export function prepareSend(
  mirror: Mirror,
  me: string | null,
  args: { chat: string; replyTo: { author: string; ts: number } | null },
  now: number,
): PreparedSend {
  const prepared = prepareChat(mirror, me, args.chat, "send")
  const quote = args.replyTo ? findQuote(mirror, prepared.chat.id, args.replyTo, now) : null
  return { ...prepared, quote }
}
