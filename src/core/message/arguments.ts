import { ToolError } from "../errors"
import { parseMessageId } from "../signal/ids"
import { MAX_TEXT_CHARACTERS } from "./constants"
import { checkedEmoji } from "./emoji"

/** The text trimmed, at most `MAX_TEXT_CHARACTERS` code points, else `invalid_argument`; it may be empty. */
function limitedText(text: string): string {
  const trimmed = text.trim()
  const length = [...trimmed].length
  if (length > MAX_TEXT_CHARACTERS) {
    throw new ToolError(
      "invalid_argument",
      `text is ${length} characters after trimming; at most ${MAX_TEXT_CHARACTERS}. Send it as several messages.`,
    )
  }
  return trimmed
}

/** The text as it will be sent: trimmed, 1 to `MAX_TEXT_CHARACTERS` code points, else `invalid_argument`. */
export function checkedText(text: string): string {
  const trimmed = limitedText(text)
  if (trimmed === "") throw new ToolError("invalid_argument", "text is blank; give the text to send.")
  return trimmed
}

/** The text that goes with a file: trimmed and at most `MAX_TEXT_CHARACTERS` code points, as `checkedText` has it, but it may be empty or absent (then ""). */
export function checkedCaption(text: string | undefined): string {
  return text === undefined ? "" : limitedText(text)
}

/** The message that the argument `name` names by its id, else `invalid_argument`. */
export function messageReference(id: string, name: string): { author: string; ts: number } {
  const reference = parseMessageId(id)
  if (!reference) {
    throw new ToolError(
      "invalid_argument",
      `${name} must be a message id, \`<account id>:<sent time in ms>\`, as a result gives it.`,
    )
  }
  return reference
}

/** What a reaction call asks for: an emoji to set, or the removal of the current one, which an emoji may confirm. */
export type ReactionRequest = { remove: false; emoji: string } | { remove: true; emoji: string | undefined }

/**
 * What a reaction call asks for. Without `remove` the `emoji` is required;
 * every emoji given must pass `checkedEmoji`. Else `invalid_argument`.
 */
export function reactionRequest(args: { emoji?: string; remove?: boolean }): ReactionRequest {
  const emoji = args.emoji === undefined ? undefined : checkedEmoji(args.emoji)
  if (args.remove) return { remove: true, emoji }
  if (emoji === undefined) throw new ToolError("invalid_argument", "emoji is required unless remove is set.")
  return { remove: false, emoji }
}
