import { withMirror } from "../../chat/open"
import { sizeFact } from "../../facts"
import { checkedCaption, messageReference } from "../../message/arguments"
import { chatFacts, chatHeadline, chatSubject, filesFacts, membersFacts, replyToFacts } from "../../message/describe"
import { prepareSend } from "../../message/prepare"
import type { CallDescription, ToolContext } from "../../tool"
import { FILE_WORDS } from "../words"
import { hashResolved, type FileDigest } from "./hash-resolved"
import { resolveFiles } from "./resolve-files"
import type { FileSendArguments } from "./schema"
import { assertApproved, type ByteBudget } from "./stage"

/**
 * The describer of a file send that takes at most `maxTotalBytes` together:
 * the checks `execute` makes on the arguments and the mirror (a call it would
 * refuse throws), the size limit and each caller's `sha256`, with each file
 * read once for its size and SHA-256. The pins are the hashes by real path
 * and the group's members, so a file rewritten or a group changed before the
 * run is caught. The content inspection stays in `execute`.
 */
export function createFileSendDescriber(maxTotalBytes: number) {
  return async function describeFileSend(args: FileSendArguments, ctx: ToolContext): Promise<CallDescription> {
    return describeFiles(args, ctx, maxTotalBytes)
  }
}

async function describeFiles(
  args: FileSendArguments,
  ctx: ToolContext,
  maxTotalBytes: number,
): Promise<CallDescription> {
  const caption = checkedCaption(args.text)
  const replyTo = args.reply_to === undefined ? null : messageReference(args.reply_to, "reply_to")
  const { prepared, subject } = await withMirror(ctx, args.account, (mirror, me) => {
    const prepared = prepareSend(mirror, me, { chat: args.chat, replyTo }, Date.now())
    return { prepared, subject: chatSubject(mirror, prepared) }
  })
  const files = await resolveFiles(args.files, ctx)
  const budget: ByteBudget = { used: 0, limit: maxTotalBytes }
  const digests: FileDigest[] = []
  for (const file of files) {
    const digest = await hashResolved(file, budget, ctx.signal)
    assertApproved(file.shown, file.sha256, digest.sha256)
    digests.push(digest)
  }

  const [only] = files
  const headline =
    only === undefined || files.length > 1
      ? chatHeadline(subject, FILE_WORDS.sendHeadline, FILE_WORDS.sendHeadlineNote)
      : chatHeadline(subject, FILE_WORDS.sendOneHeadline, FILE_WORDS.sendOneHeadlineNote, { file: only.resolved.name })
  return {
    ...(headline && { headline }),
    facts: [
      ...chatFacts(subject),
      ...replyToFacts(prepared.quote),
      ...membersFacts(subject),
      ...(files.length > 1 ? filesFacts(files.length) : []),
      sizeFact(digests.reduce((total, { size }) => total + size, 0)),
    ],
    ...(caption !== "" && { text: { label: FILE_WORDS.caption, body: caption } }),
    pins: {
      ...subject.pins,
      ...Object.fromEntries(
        files.map((file, position) => [`sha256:${file.resolved.realPath}`, digests[position]!.sha256]),
      ),
    },
  }
}
