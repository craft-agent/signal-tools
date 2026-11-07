import { withMirror } from "../chat/open"
import { ToolError } from "../errors"
import { parseMessageId } from "../signal/ids"
import { pickLabel } from "../signal/labels"
import { defineTool, StepErrors } from "../tool"
import { ANY_TARGET } from "../targets"
import { MAX_TEXT_CHARACTERS, MESSAGE_SEND_TOOL_ID } from "./constants"
import { prepareSend } from "./prepare"
import { recordSent } from "./record"
import { sendResult } from "./result"
import { input, output, type SendOutput } from "./schema"
import { transmit } from "./transmit"

/** The text as it will be sent: trimmed, 1 to `MAX_TEXT_CHARACTERS` code points, else `invalid_argument`. */
function checkedText(text: string): string {
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

/** The message a reply names, else `invalid_argument`; null without a reply. */
function replyReference(replyTo: string | undefined): { author: string; ts: number } | null {
  if (replyTo === undefined) return null
  const reference = parseMessageId(replyTo)
  if (!reference) {
    throw new ToolError(
      "invalid_argument",
      "reply_to must be a message id, `<account id>:<sent time in ms>`, as a result gives it.",
    )
  }
  return reference
}

/** The `signal_message_send` tool definition. */
export const signalMessageSend = defineTool({
  id: MESSAGE_SEND_TOOL_ID,
  title: "Send a message",
  description: [
    "Sends one text to a chat: a person, a group or Note to Self (the user's own account id as the chat).",
    "`chat` is a chat id from signal_chat_read or signal_contact_read check, never a name or a number.",
    `\`text\` is sent exactly as given, surrounding blank space trimmed, at most ${MAX_TEXT_CHARACTERS} characters.`,
    "`reply_to` quotes a message of that chat by its id; one that was deleted or has disappeared cannot be quoted.",
    "A group the user left is refused. The chat's disappearing timer applies by itself.",
    "The result means Signal accepted it, not that it was delivered or read; for a group it says how many members it reached and lists those it did not.",
    "A failure `uncertain` means the message may have gone out: check the chat on the phone, never send it again blindly.",
    "A send is recorded in the local mirror; `errors.record` says when that failed although the message was sent.",
  ].join(" "),
  toolset: "sends",
  class: "add",
  input,
  output,
  async targets(args, ctx) {
    if (!ctx.stateDir) return [ANY_TARGET]
    try {
      const { label } = await pickLabel(ctx.stateDir, args.account)
      return [`${label}/${args.chat}`]
    } catch {
      return [ANY_TARGET]
    }
  },
  async execute(args, ctx): Promise<SendOutput> {
    const text = checkedText(args.text)
    const replyTo = replyReference(args.reply_to)
    const now = Date.now()
    const { paths, prepared } = await withMirror(ctx, args.account, (mirror, me, paths) => ({
      paths,
      prepared: prepareSend(mirror, me, { chat: args.chat, replyTo }, now),
    }))
    const sent = await transmit(paths, prepared, text, ctx.signal)
    const result = sendResult(prepared.chat.id, prepared.me, sent)
    const steps = new StepErrors()
    await steps.record("record", async () => recordSent(paths, prepared, text, sent.timestamp))
    if (steps.any) result.errors = { record: steps.errors.record! }
    return result
  },
})
