import { unknownChat } from "../chat/chat-rows"
import { excludedChats, refuseExcludedChats } from "../chat/excluded"
import { withMirror } from "../chat/open"
import { messageId } from "../signal/ids"
import { defineTool, StepErrors } from "../tool"
import { reactInput, reactOutput, type ReactOutput } from "./action-schema"
import { messageReference, reactionRequest } from "./arguments"
import { MAX_EMOJI_UNITS, MESSAGE_REACT_TOOL_ID } from "./constants"
import { deliver } from "./deliver"
import { authorFacts, chatFacts, chatHeadline, chatSubject, membersFacts, messageTextFact } from "./describe"
import { prepareChat } from "./prepare"
import { prepareReaction } from "./react-prepare"
import { recordReaction } from "./record-action"
import { reactResult } from "./result"
import { labelTargets } from "./targets"
import { MESSAGE_WORDS } from "./words"

const REACT_METHOD = "sendReaction"

/** The `signal_message_react` tool definition. */
export const signalMessageReact = defineTool({
  id: MESSAGE_REACT_TOOL_ID,
  title: "React to a message",
  description: [
    "Reacts with one emoji to a message of a chat, the user's own or another person's, by its id from signal_chat_read.",
    "`chat` is a chat id from signal_chat_read or signal_contact_read check, never a name or a number.",
    `\`emoji\` is exactly one emoji (at most ${MAX_EMOJI_UNITS} characters); it is required unless \`remove\` is set.`,
    "A person has one reaction per message, so a new one replaces the user's earlier one; reacting with the emoji already there is refused.",
    "`remove: true` removes the user's reaction: leave `emoji` out to remove the current one, or give that same emoji; with no reaction there it is `not_found`.",
    "A message that was deleted or has disappeared cannot be reacted to, and a group the user left is refused.",
    "The result means Signal accepted it, not that it was delivered or read; for a group it says how many members it reached and lists those it did not.",
    "A failure `uncertain` means the reaction may have gone out: check the chat on the phone, never repeat it blindly.",
    "A reaction is recorded in the local mirror; `errors.record` says when that failed although the reaction was sent.",
  ].join(" "),
  intent: MESSAGE_WORDS.reactIntent,
  toolset: "actions",
  class: "overwrite",
  input: reactInput,
  output: reactOutput,
  gate: (args, ctx) => refuseExcludedChats(ctx, [args.chat], unknownChat),
  targets: (args, ctx) => labelTargets(ctx, args.account, args.chat, args.id),
  async describe(args, ctx) {
    const request = reactionRequest(args)
    const target = messageReference(args.id, "id")
    return withMirror(ctx, args.account, (mirror, me) => {
      const now = Date.now()
      const prepared = prepareChat(mirror, me, args.chat, "react")
      const reaction = prepareReaction(mirror, prepared, target, request, now)
      const subject = chatSubject(mirror, prepared, excludedChats(ctx))
      const values = { emoji: reaction.emoji }
      const headline = reaction.remove
        ? chatHeadline(
            subject,
            MESSAGE_WORDS.unreactHeadline,
            MESSAGE_WORDS.unreactHeadlineNote,
            values,
            MESSAGE_WORDS.unreactUnnamed,
          )
        : chatHeadline(
            subject,
            MESSAGE_WORDS.reactHeadline,
            MESSAGE_WORDS.reactHeadlineNote,
            values,
            MESSAGE_WORDS.reactUnnamed,
          )
      return {
        headline,
        facts: [
          ...chatFacts(subject),
          ...(reaction.replaces === null ? [] : [{ label: MESSAGE_WORDS.replaces, value: reaction.replaces }]),
          ...authorFacts(subject, target.author),
          messageTextFact(subject, MESSAGE_WORDS.message, reaction.message),
          ...membersFacts(subject),
        ],
        pins: subject.pins,
      }
    })
  },
  async execute(args, ctx): Promise<ReactOutput> {
    const request = reactionRequest(args)
    const target = messageReference(args.id, "id")
    const now = Date.now()
    const { paths, prepared, reaction } = await withMirror(ctx, args.account, (mirror, me, paths) => {
      const prepared = prepareChat(mirror, me, args.chat, "react")
      return { paths, prepared, reaction: prepareReaction(mirror, prepared, target, request, now) }
    })
    const params = {
      emoji: reaction.emoji,
      targetAuthor: target.author,
      targetTimestamp: target.ts,
      ...(reaction.remove ? { remove: true } : {}),
    }
    const sent = await deliver(paths, prepared, REACT_METHOD, params, { action: "react", signal: ctx.signal })
    const result = reactResult(prepared.chat.id, messageId(target.author, target.ts), reaction, sent)
    const steps = new StepErrors()
    await steps.record("record", async () =>
      recordReaction(paths, prepared, { ...reaction, timestamp: sent.timestamp }),
    )
    if (steps.any) result.errors = { record: steps.errors.record! }
    return result
  },
})
