import { existingChat, isNoteToSelf } from "../chat/chat-rows"
import { withMirror } from "../chat/open"
import { authorFacts, chatHeadline, chatSubject, filesFacts } from "../message/describe"
import type { CallDescription, ToolContext } from "../tool"
import { findMessageFiles } from "./message-files"
import type { FileSaveArguments } from "./schema"
import { FILE_WORDS } from "./words"

/**
 * What a file save will do, for the person who approves it: the check
 * `execute` makes on the message (a call it would refuse throws), read from the
 * mirror. A group the user left can still be saved from, and nothing needs the
 * user's own id, so the chat is not prepared for a send. The download directory
 * is checked in `execute`. `now` is the clock `execute` reads.
 */
export function fileSaveDescriber(now: () => number) {
  return (args: FileSaveArguments, ctx: ToolContext): Promise<CallDescription> =>
    withMirror(ctx, args.account, (mirror, me) => {
      const message = findMessageFiles(mirror, me, args.chat, args.id, now())
      const chat = existingChat(mirror, me, message.chat)
      const subject = chatSubject(mirror, { chat, me, noteToSelf: isNoteToSelf(chat.id, me) })
      const headline = chatHeadline(subject, FILE_WORDS.saveHeadline, FILE_WORDS.saveHeadlineNote)
      return {
        ...(headline && { headline }),
        facts: [
          ...authorFacts(subject, message.author),
          ...filesFacts(message.files.length),
          ...(args.unpack ? [{ label: FILE_WORDS.unpack, value: { text: FILE_WORDS.unpackValue } }] : []),
        ],
      }
    })
}
