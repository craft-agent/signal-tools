import { ToolError } from "../errors"
import type { IngestContext } from "../signal/ingest-context"
import { storeMessage, type Sender } from "../signal/ingest-messages"
import type { LabelPaths } from "../signal/labels"
import { inTransaction, openMirrorForRecord, type Mirror } from "../signal/mirror"
import type { PreparedSend } from "./prepare"

const NOT_RECORDED = "the message was sent but is not in the mirror yet"
const MIRROR_NOT_WRITTEN = "The mirror could not be written"

/**
 * Runs `work` on the label's mirror, opened for a record: only if it is of the
 * current version, never migrating it, with the ingest context of the label's
 * account. `work` opens its own transaction. Any failure throws a `ToolError`
 * that says what went out but is not in the mirror yet (`notRecorded`).
 */
export function recordInMirror<T>(
  paths: LabelPaths,
  me: string,
  notRecorded: string,
  work: (mirror: Mirror, ctx: IngestContext) => T,
): T {
  try {
    const mirror = openMirrorForRecord(paths.mirror)
    try {
      // A record reads no attachment, so the directory is only the one the sync service gives its context.
      return work(mirror, { me, attachmentsDir: paths.attachments, now: Date.now() })
    } finally {
      mirror.close()
    }
  } catch (error) {
    const reason = error instanceof ToolError ? error.message.replace(/\.$/, "") : MIRROR_NOT_WRITTEN
    throw new ToolError("upstream_error", `${reason}, ${notRecorded}`, { cause: error })
  }
}

/** What the sync service would store for this message, were it sent from another device: a data message of a sent transcript. */
function sentTranscript(prepared: PreparedSend, text: string, timestamp: number): Record<string, unknown> {
  const { chat, quote } = prepared
  return {
    timestamp,
    message: text,
    expiresInSeconds: chat.expires_in ?? 0,
    ...(quote
      ? {
          quote: {
            id: quote.timestamp,
            authorUuid: quote.author,
            text: quote.text,
            mentions: quote.mentions,
          },
        }
      : {}),
  }
}

/**
 * Records a message Signal accepted in the label's mirror, as the sync
 * service stores what the user sends from another device: one transaction,
 * by `storeMessage`. Any failure throws a `ToolError` that says the message
 * was sent but is not in the mirror yet.
 */
export function recordSent(paths: LabelPaths, prepared: PreparedSend, text: string, timestamp: number): void {
  const { chat, me } = prepared
  recordInMirror(paths, me, NOT_RECORDED, (mirror, ctx) => {
    const sender: Sender = { chat: chat.id, author: me, fromMe: true, authorName: null }
    const stored = inTransaction(mirror, () =>
      storeMessage(mirror, ctx, sender, sentTranscript(prepared, text, timestamp)),
    )
    if (stored !== "message") throw new ToolError("internal_error", "The mirror did not keep the message")
  })
}
