import { withMirror } from "../chat/open"
import { defineTool, StepErrors } from "../tool"
import { checkedText, messageReference } from "./arguments"
import { MAX_TEXT_CHARACTERS, MESSAGE_SEND_TOOL_ID } from "./constants"
import {
  chatFacts,
  chatHeadline,
  chatSubject,
  membersFacts,
  replyHeadline,
  replyToFacts,
  type ReplyHeadlines,
} from "./describe"
import { prepareSend } from "./prepare"
import { recordSent } from "./record"
import { sendResult } from "./result"
import { input, output, type SendOutput } from "./schema"
import { labelTargets } from "./targets"
import { transmit } from "./transmit"
import { MESSAGE_WORDS } from "./words"

/** The headlines of a send that replies to a message. */
const REPLY_HEADLINES: ReplyHeadlines = {
  author: MESSAGE_WORDS.replyHeadline,
  person: MESSAGE_WORDS.replyHeadlinePerson,
  own: MESSAGE_WORDS.replyHeadlineOwn,
  unnamed: MESSAGE_WORDS.replyHeadlineUnnamed,
  noteToSelf: MESSAGE_WORDS.replyHeadlineNote,
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
  intent: MESSAGE_WORDS.sendIntent,
  toolset: "sends",
  class: "add",
  input,
  output,
  targets: (args, ctx) => labelTargets(ctx, args.account, args.chat),
  async describe(args, ctx) {
    const text = checkedText(args.text)
    const replyTo = args.reply_to === undefined ? null : messageReference(args.reply_to, "reply_to")
    return withMirror(ctx, args.account, (mirror, me) => {
      const prepared = prepareSend(mirror, me, { chat: args.chat, replyTo }, Date.now())
      const subject = chatSubject(mirror, prepared)
      return {
        headline: prepared.quote
          ? replyHeadline(subject, prepared.quote, REPLY_HEADLINES)
          : chatHeadline(subject, MESSAGE_WORDS.sendHeadline, MESSAGE_WORDS.sendHeadlineNote),
        facts: [...chatFacts(subject), ...replyToFacts(subject, prepared.quote), ...membersFacts(subject)],
        text: { label: MESSAGE_WORDS.sendText, body: text },
        pins: subject.pins,
      }
    })
  },
  async execute(args, ctx): Promise<SendOutput> {
    const text = checkedText(args.text)
    const replyTo = args.reply_to === undefined ? null : messageReference(args.reply_to, "reply_to")
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
