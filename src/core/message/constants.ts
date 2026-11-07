export const MESSAGE_SEND_TOOL_ID = "signal_message_send"
export const MESSAGE_EDIT_TOOL_ID = "signal_message_edit"
export const MESSAGE_DELETE_TOOL_ID = "signal_message_delete"

/** The most characters a text may have, counted as Unicode code points after trimming. */
export const MAX_TEXT_CHARACTERS = 4_000

/** How long after sending Signal lets the user edit a message or delete it for everyone. */
export const ACTION_WINDOW_MS = 24 * 60 * 60 * 1000

/** How many times Signal lets a message be edited. */
export const MAX_EDITS = 10

/** What a delivery to Signal does to a message. */
export type DeliveryAction = "send" | "edit" | "delete"

/** What a delivery says when it may have gone out but Signal's answer was lost, by action. */
export const UNCERTAIN_MESSAGES: Record<DeliveryAction, string> = {
  send: "The message may have been sent. Check the chat on the phone before sending it again.",
  edit: "The edit may have gone out. Check the chat on the phone before editing again.",
  delete: "The message may have been deleted for everyone. Check the chat on the phone before deleting again.",
}

/** What a call says when the mirror has no message with the given id in that chat. */
export const UNKNOWN_MESSAGE = "No message with this id in this chat."

/** What a call says of a message that was deleted for everyone or has disappeared. */
export const GONE_MESSAGE = "That message is gone; it was deleted or has disappeared."
