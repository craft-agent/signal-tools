import { withMirror } from "../chat/open"
import { messageId } from "../signal/ids"
import { defineTool, StepErrors } from "../tool"
import { editInput, editOutput, type EditOutput } from "./action-schema"
import { checkedText, messageReference } from "./arguments"
import { MAX_EDITS, MAX_TEXT_CHARACTERS, MESSAGE_EDIT_TOOL_ID } from "./constants"
import { deliver } from "./deliver"
import { chatFacts, chatHeadline, chatSubject, membersFacts, writtenFact } from "./describe"
import { prepareEdit } from "./edit-prepare"
import { prepareChat } from "./prepare"
import { quoteParams } from "./quote"
import { recordEdit } from "./record-action"
import { editResult } from "./result"
import { labelTargets } from "./targets"
import { MESSAGE_WORDS } from "./words"

/** The `signal_message_edit` tool definition. */
export const signalMessageEdit = defineTool({
  id: MESSAGE_EDIT_TOOL_ID,
  title: "Edit a message",
  description: [
    "Edits one of the user's own messages, replacing its text for everyone in the chat.",
    "`chat` is a chat id from signal_chat_read or signal_contact_read check, never a name or a number; `id` is the message's id from signal_chat_read.",
    `\`text\` is the whole new text, sent exactly as given, surrounding blank space trimmed, at most ${MAX_TEXT_CHARACTERS} characters.`,
    `Signal allows an edit only within 24 hours of sending and at most ${MAX_EDITS} times per message; it is refused for another person's message, a message with files, a view-once message and a text that changes nothing.`,
    "A reply keeps its quote; mentions and text styles of the original are not carried over, because the new text is plain. A group the user left is refused.",
    "The result means Signal accepted it, not that it was delivered or read; for a group it says how many members it reached and lists those it did not. `edits_left` is how many more edits the message takes.",
    "A failure `uncertain` means the edit may have gone out: check the chat on the phone, never repeat it blindly.",
    "An edit is recorded in the local mirror, which keeps the earlier versions; `errors.record` says when that failed although the edit was sent.",
  ].join(" "),
  intent: MESSAGE_WORDS.editIntent,
  toolset: "actions",
  class: "overwrite",
  input: editInput,
  output: editOutput,
  targets: (args, ctx) => labelTargets(ctx, args.account, args.chat, args.id),
  async describe(args, ctx) {
    const text = checkedText(args.text)
    const reference = messageReference(args.id, "id")
    return withMirror(ctx, args.account, (mirror, me) => {
      const prepared = prepareChat(mirror, me, args.chat, "edit")
      const edit = prepareEdit(mirror, prepared, reference, text, Date.now())
      const subject = chatSubject(mirror, prepared)
      return {
        headline: chatHeadline(subject, MESSAGE_WORDS.editHeadline, MESSAGE_WORDS.editHeadlineNote),
        facts: [...chatFacts(subject), writtenFact(MESSAGE_WORDS.editCurrent, edit.body), ...membersFacts(subject)],
        text: { label: MESSAGE_WORDS.editText, body: text },
      }
    })
  },
  async execute(args, ctx): Promise<EditOutput> {
    const text = checkedText(args.text)
    const reference = messageReference(args.id, "id")
    const now = Date.now()
    const { paths, prepared, edit } = await withMirror(ctx, args.account, (mirror, me, paths) => {
      const prepared = prepareChat(mirror, me, args.chat, "edit")
      return { paths, prepared, edit: prepareEdit(mirror, prepared, reference, text, now) }
    })
    const params = {
      editTimestamp: edit.timestamp,
      message: text,
      ...(edit.quote ? quoteParams(edit.quote) : {}),
    }
    const sent = await deliver(paths, prepared, "send", params, { action: "edit", signal: ctx.signal })
    const result = editResult(prepared.chat.id, messageId(prepared.me, edit.timestamp), sent, edit.editsLeft)
    const steps = new StepErrors()
    await steps.record("record", async () =>
      recordEdit(paths, prepared, { timestamp: edit.timestamp, edited: sent.timestamp, text }),
    )
    if (steps.any) result.errors = { record: steps.errors.record! }
    return result
  },
})
