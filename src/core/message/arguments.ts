import { ToolError } from "../errors"
import { parseMessageId } from "../signal/ids"
import { MAX_TEXT_CHARACTERS } from "./constants"

/** The text as it will be sent: trimmed, 1 to `MAX_TEXT_CHARACTERS` code points, else `invalid_argument`. */
export function checkedText(text: string): string {
  const trimmed = text.trim()
  const length = [...trimmed].length
  if (length === 0) throw new ToolError("invalid_argument", "text is blank; give the text to send.")
  if (length > MAX_TEXT_CHARACTERS) {
    throw new ToolError(
      "invalid_argument",
      `text is ${length} characters after trimming; at most ${MAX_TEXT_CHARACTERS}. Send it as several messages.`,
    )
  }
  return trimmed
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
