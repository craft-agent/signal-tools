import { ToolError } from "../errors"
import type { Mirror } from "../signal/mirror"
import type { ReactionRequest } from "./arguments"
import { findLiveRow } from "./lookup"
import type { PreparedChat } from "./prepare"

/** What a reaction needs from the mirror, read before anything is sent. */
export type PreparedReaction = {
  /** The reacted-to message by its author and sent time, as Signal points at it. */
  target: { author: string; ts: number }
  /** The emoji to send: the one to set, or the user's current one when removing. */
  emoji: string
  remove: boolean
  /** The user's current emoji on the message that setting a new one replaces; null when there is none, and when removing. */
  replaces: string | null
  /** The reacted-to message's text, view-once mark and disappearing timer, for the description of the call. */
  message: { body: string | null; view_once: number; expires_in: number }
}

/** The emoji the user reacted to a message with, or null. */
function currentReaction(mirror: Mirror, target: { author: string; ts: number }, me: string): string | null {
  const row = mirror
    .prepare("SELECT emoji FROM reactions WHERE author = ? AND ts = ? AND reactor = ?")
    .get(target.author, target.ts, me) as { emoji: string } | undefined
  return row?.emoji ?? null
}

/**
 * Checks, in the mirror, that the user can react to the message (their own
 * or another's, any age, view-once too) and what the call comes to. Setting
 * the emoji the user already has is `invalid_argument`. Removing needs a
 * reaction there (else `not_found`), and an `emoji` given with it must be that
 * one (else `not_found`); without one, the current reaction is removed. See
 * `findLiveRow` for the message rules.
 */
export function prepareReaction(
  mirror: Mirror,
  { chat, me }: PreparedChat,
  target: { author: string; ts: number },
  reaction: ReactionRequest,
  now: number,
): PreparedReaction {
  const row = findLiveRow<{ body: string | null; view_once: number }>(mirror, chat.id, target, "body, view_once", now)
  const message = { body: row.body, view_once: row.view_once, expires_in: row.expires_in }
  const current = currentReaction(mirror, target, me)
  if (reaction.remove) {
    if (current === null) throw new ToolError("not_found", "You have not reacted to that message.")
    if (reaction.emoji !== undefined && reaction.emoji !== current) {
      throw new ToolError(
        "not_found",
        "Your reaction to that message is another emoji, not that one; remove it without giving an emoji.",
      )
    }
    return { target, emoji: current, remove: true, replaces: null, message }
  }
  if (reaction.emoji === current) throw new ToolError("invalid_argument", "That reaction is already there.")
  return { target, emoji: reaction.emoji, remove: false, replaces: current, message }
}
