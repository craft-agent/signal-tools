import { ToolError } from "../errors"
import type { Mirror } from "../signal/mirror"
import { ACTION_WINDOW_MS } from "./constants"
import { findLiveRow } from "./lookup"

/** What the user does to a message of their own for everyone. */
export type OwnAction = "edit" | "delete"

/** The action as the refusal names it. */
const PASSIVE: Record<OwnAction, string> = { edit: "edited", delete: "deleted for everyone" }

const COLUMNS = "ts, body, mentions, attachments, quote, sticker, other, view_once, edited, expires_in"

/** The columns of the user's own message that an action needs to decide and to carry on. */
export type OwnMessage = {
  /** The message's sent time: the one Signal points at. */
  ts: number
  body: string | null
  mentions: string | null
  attachments: string | null
  /** The stored quote, as JSON. */
  quote: string | null
  sticker: number
  other: string | null
  view_once: number
  /** The time of the latest edit; null for a message never edited. */
  edited: number | null
  /** The message's disappearing timer in seconds, 0 for none. */
  expires_in: number
}

/**
 * The user's own message of `chat` that `reference` names, for an action that
 * Signal allows only on those, and only within a day of sending. `not_found`
 * for an unknown message, one of another chat or a timer change, and for one
 * deleted for everyone or expired (saying it is gone); `forbidden` for
 * another person's message, and for one sent more than `ACTION_WINDOW_MS` ago.
 */
export function findOwnMessage(
  mirror: Mirror,
  chat: string,
  reference: { author: string; ts: number },
  me: string,
  now: number,
  action: OwnAction,
): OwnMessage {
  const row = findLiveRow<OwnMessage>(mirror, chat, reference, COLUMNS, now)
  if (reference.author !== me) {
    throw new ToolError("forbidden", `Only your own messages can be ${PASSIVE[action]}.`)
  }
  if (now - row.ts > ACTION_WINDOW_MS) {
    throw new ToolError("forbidden", "Signal allows this only within 24 hours of sending.")
  }
  return row
}
