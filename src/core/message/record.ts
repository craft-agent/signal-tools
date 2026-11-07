import { join } from "node:path"
import { ToolError } from "../errors"
import { storeMessage, type Sender } from "../signal/ingest-messages"
import type { LabelPaths } from "../signal/labels"
import { inTransaction, openMirrorForRecord } from "../signal/mirror"
import type { PreparedSend } from "./prepare"

const NOT_RECORDED = "the message was sent but is not in the mirror yet"
const MIRROR_NOT_WRITTEN = "The mirror could not be written"

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
 * by `storeMessage`. It opens the mirror only if it is of the current
 * version, never migrating it. Any failure throws a `ToolError` that says
 * the message was sent but is not in the mirror yet.
 */
export function recordSent(paths: LabelPaths, prepared: PreparedSend, text: string, timestamp: number): void {
  const { chat, me } = prepared
  try {
    const mirror = openMirrorForRecord(paths.mirror)
    try {
      // storeMessage reads no attachment, so the directory is only the one the sync service gives its context.
      const ctx = { me, attachmentsDir: join(paths.signalCli, "attachments"), now: Date.now() }
      const sender: Sender = { chat: chat.id, author: me, fromMe: true, authorName: null }
      const stored = inTransaction(mirror, () =>
        storeMessage(mirror, ctx, sender, sentTranscript(prepared, text, timestamp)),
      )
      if (stored !== "message") throw new ToolError("internal_error", "The mirror did not keep the message")
    } finally {
      mirror.close()
    }
  } catch (error) {
    const reason = error instanceof ToolError ? error.message.replace(/\.$/, "") : MIRROR_NOT_WRITTEN
    throw new ToolError("upstream_error", `${reason}, ${NOT_RECORDED}`, { cause: error })
  }
}
