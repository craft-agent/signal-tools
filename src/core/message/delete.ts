import { unknownChat } from "../chat/chat-rows"
import { excludedChats, refuseExcludedChats } from "../chat/excluded"
import { readList } from "../chat/message-rows"
import { withMirror } from "../chat/open"
import { messageId } from "../signal/ids"
import type { StoredMention } from "../signal/mirror-parts"
import { defineTool, StepErrors } from "../tool"
import { deleteInput, deleteOutput, type DeleteOutput } from "./action-schema"
import { messageReference } from "./arguments"
import { MESSAGE_DELETE_TOOL_ID } from "./constants"
import { deliver } from "./deliver"
import { chatFacts, chatHeadline, chatSubject, filesFacts, membersFacts, messageTextFact } from "./describe"
import { findOwnMessage } from "./own"
import { prepareChat } from "./prepare"
import { recordDelete } from "./record-action"
import { deleteResult } from "./result"
import { labelTargets } from "./targets"
import { MESSAGE_WORDS } from "./words"

const DELETE_METHOD = "remoteDelete"

/** The `signal_message_delete` tool definition. */
export const signalMessageDelete = defineTool({
  id: MESSAGE_DELETE_TOOL_ID,
  title: "Delete a message for everyone",
  description: [
    "Deletes one of the user's own messages for everyone in the chat, within 24 hours of sending it; it cannot be undone.",
    "`chat` is a chat id from signal_chat_read or signal_contact_read check, never a name or a number; `id` is the message's id from signal_chat_read.",
    "Another person's message is refused, and so is a group the user left.",
    "The result means Signal accepted it, not that it was delivered or read; for a group it says how many members it reached and lists those it did not.",
    "A failure `uncertain` means the deletion may have gone out: check the chat on the phone, never repeat it blindly.",
    "A deletion is recorded in the local mirror, which then drops the message, its files, its earlier versions, its reactions and every quote of it; `errors.record` says when that failed although the message was deleted.",
  ].join(" "),
  intent: MESSAGE_WORDS.deleteIntent,
  toolset: "actions",
  class: "administrative",
  input: deleteInput,
  output: deleteOutput,
  gate: (args, ctx) => refuseExcludedChats(ctx, [args.chat], unknownChat),
  targets: (args, ctx) => labelTargets(ctx, args.account, args.chat, args.id),
  async describe(args, ctx) {
    const reference = messageReference(args.id, "id")
    return withMirror(ctx, args.account, (mirror, me) => {
      const prepared = prepareChat(mirror, me, args.chat, "delete")
      const message = findOwnMessage(mirror, prepared.chat.id, reference, prepared.me, Date.now(), "delete")
      const subject = chatSubject(mirror, prepared, excludedChats(ctx))
      return {
        headline: chatHeadline(subject, MESSAGE_WORDS.deleteHeadline, MESSAGE_WORDS.deleteHeadlineNote),
        facts: [
          ...chatFacts(subject),
          messageTextFact(subject, MESSAGE_WORDS.message, {
            ...message,
            mentions: readList<StoredMention>(message.mentions),
          }),
          ...membersFacts(subject),
          ...filesFacts(readList(message.attachments).length),
        ],
        pins: subject.pins,
      }
    })
  },
  async execute(args, ctx): Promise<DeleteOutput> {
    const reference = messageReference(args.id, "id")
    const now = Date.now()
    const { paths, prepared, timestamp } = await withMirror(ctx, args.account, (mirror, me, paths) => {
      const prepared = prepareChat(mirror, me, args.chat, "delete")
      const { ts } = findOwnMessage(mirror, prepared.chat.id, reference, prepared.me, now, "delete")
      return { paths, prepared, timestamp: ts }
    })
    const sent = await deliver(
      paths,
      prepared,
      DELETE_METHOD,
      { targetTimestamp: timestamp },
      { action: "delete", signal: ctx.signal },
    )
    const result = deleteResult(prepared.chat.id, messageId(prepared.me, timestamp), sent)
    const steps = new StepErrors()
    await steps.record("record", async () => recordDelete(paths, prepared, timestamp))
    if (steps.any) result.errors = { record: steps.errors.record! }
    return result
  },
})
