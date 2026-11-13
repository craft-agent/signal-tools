export const MESSAGE_SEND_TOOL_ID = "signal_message_send"
export const MESSAGE_EDIT_TOOL_ID = "signal_message_edit"
export const MESSAGE_DELETE_TOOL_ID = "signal_message_delete"
export const MESSAGE_REACT_TOOL_ID = "signal_message_react"

/** The most characters a text may have, counted as Unicode code points after trimming. */
export const MAX_TEXT_CHARACTERS = 4_000

/** How long after sending Signal lets the user edit a message or delete it for everyone. */
export const ACTION_WINDOW_MS = 24 * 60 * 60 * 1000

/** How many times Signal lets a message be edited. */
export const MAX_EDITS = 10

/** The most UTF-16 code units an emoji may have; one emoji is a cluster of a few code points, such as a family. */
export const MAX_EMOJI_UNITS = 64

/** What a delivery to Signal does to a message. */
export type DeliveryAction = "send" | "edit" | "delete" | "react"

/** What a delivery says when it may have gone out but Signal's answer was lost, by action. */
export const UNCERTAIN_MESSAGES: Record<DeliveryAction, string> = {
  send: "The message may have been sent. Check the chat on the phone before sending it again.",
  edit: "The edit may have gone out. Check the chat on the phone before editing again.",
  delete: "The message may have been deleted for everyone. Check the chat on the phone before deleting again.",
  react: "The reaction may have gone out. Check the chat on the phone before reacting again.",
}

/** What a call says when the mirror has no message with the given id in that chat. */
export const UNKNOWN_MESSAGE = "No message with this id in this chat."

/** What a call says of a message that was deleted for everyone or has disappeared. */
export const GONE_MESSAGE = "That message is gone; it was deleted or has disappeared."

/** What a send says of a reply to a message with no text and no file a reply can quote. */
export const EMPTY_QUOTE_SEND_MESSAGE =
  "That message has no text and no file a reply can quote, and Signal on iPhone does not show a reply whose quote is empty. Send it without reply_to."

/** What an edit says of a reply whose stored quote has no text and no file. */
export const EMPTY_QUOTE_EDIT_MESSAGE =
  "This reply's quote has no text and no file, and Signal on iPhone does not show a reply whose quote is empty, so it cannot be edited."
