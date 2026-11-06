import { isRecord } from "./daemon-errors"
import { accountId } from "./ids"
import { absorb, type IngestContext, type IngestResult } from "./ingest-context"
import { editMessage } from "./ingest-edit"
import { applyDataMessage, groupChatOf, type Sender } from "./ingest-messages"
import { applySyncMessage } from "./ingest-sync"
import type { Mirror } from "./mirror"
import { textOrNull } from "./mirror-parts"
import { contactUuid } from "./mirror-rows"

export type { IngestContext, IngestResult } from "./ingest-context"
export { removeFiles } from "./ingest-delete"

/** Remembers the name a sender gave themselves, and their number when the envelope carries it. */
function learnSender(mirror: Mirror, ctx: IngestContext, source: string, envelope: Record<string, unknown>): void {
  const name = textOrNull(envelope.sourceName)
  if (source === ctx.me || !name) return
  mirror
    .prepare(
      `INSERT INTO contacts (uuid, number, profile_name, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT (uuid) DO UPDATE SET
         profile_name = excluded.profile_name, number = COALESCE(excluded.number, contacts.number)`,
    )
    .run(source, textOrNull(envelope.sourceNumber), name, ctx.now)
}

/** What an envelope's own data message and edit do, for a sender known by account id. */
function applyFromSource(
  mirror: Mirror,
  ctx: IngestContext,
  source: string,
  envelope: Record<string, unknown>,
): IngestResult {
  const result: IngestResult = { done: [], removeFiles: [] }
  const authorName = textOrNull(envelope.sourceName)
  const sender = (chat: string): Sender => ({ chat, author: source, fromMe: source === ctx.me, authorName })
  // The chat is the group the message names, else the sender's own; a malformed group id has no chat.
  const chatOf = (data: unknown): string | null => {
    const group = groupChatOf(data)
    return group === undefined ? source : group
  }
  if (isRecord(envelope.dataMessage)) {
    const chat = chatOf(envelope.dataMessage)
    if (chat) absorb(result, applyDataMessage(mirror, ctx, sender(chat), envelope.dataMessage))
  }
  if (isRecord(envelope.editMessage)) {
    const chat = chatOf(envelope.editMessage.dataMessage)
    const edited = chat ? editMessage(mirror, ctx, sender(chat), envelope.editMessage) : null
    result.done.push(edited ?? "edit-skipped")
  }
  return result
}

/**
 * Applies one `receive` notification's result (`{ envelope, account }`) to
 * the mirror, in the caller's transaction. Returns what it did, as kinds for
 * a log (never content, ids or numbers), and the files of the messages it
 * deleted. It touches no file: the caller passes `removeFiles` to the
 * function of that name once the transaction has committed, so a rollback
 * never loses files whose rows remain. Input that is not what signal-cli
 * documents is ignored; a failure of the mirror itself throws.
 */
export function ingestEnvelope(mirror: Mirror, payload: unknown, ctx: IngestContext): IngestResult {
  const envelope = isRecord(payload) ? payload.envelope : null
  if (!isRecord(envelope)) return { done: ["no-envelope"], removeFiles: [] }
  const source = accountId(envelope.sourceUuid) ?? contactUuid(mirror, envelope.sourceNumber)
  const result: IngestResult = { done: [], removeFiles: [] }
  if (source) {
    learnSender(mirror, ctx, source, envelope)
    absorb(result, applyFromSource(mirror, ctx, source, envelope))
  }
  if (isRecord(envelope.syncMessage)) absorb(result, applySyncMessage(mirror, ctx, envelope.syncMessage))
  if (result.done.length === 0) result.done.push("ignored")
  return result
}
