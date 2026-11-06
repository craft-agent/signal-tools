import { rmSync } from "node:fs"
import { join } from "node:path"
import type { IngestContext } from "./ingest-context"
import { attachmentIds } from "./mirror-parts"
import type { Mirror } from "./mirror"
import { findMessage, recordDeleted } from "./mirror-rows"

/** The paths of the files of the attachments in a stored column, for the ids that are plain file names. */
function filesOf(attachmentsDir: string, attachments: string | null): string[] {
  return attachmentIds(attachments)
    .filter((id) => id !== "" && !id.includes("/") && !id.startsWith("."))
    .map((id) => join(attachmentsDir, id))
}

/**
 * Removes files, once the transaction that deleted their messages has
 * committed. A file that is already gone is fine; any other failure is
 * ignored too, since the message is gone either way and a file that stays
 * is the lesser harm.
 */
export function removeFiles(paths: string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { force: true })
    } catch {
      // See above: nothing to do about a file that cannot be removed.
    }
  }
}

/**
 * A delete for everyone, by `author` (a message can only be deleted by its
 * sender): the message, earlier versions and reactions go, and so does every
 * quote of it, matched by any time the message went by. Every one of those
 * times, and `ts` as given, is recorded in `deleted` (author and times only),
 * also when there is no message yet, so that a message, edit or reaction
 * arriving later is dropped.
 *
 * Touches no file: returns the paths of the files of the message and its
 * earlier versions for `removeFiles`, or null when there was no message.
 */
export function deleteMessage(mirror: Mirror, ctx: IngestContext, author: string, ts: number): string[] | null {
  const row = findMessage(mirror, author, ts)
  const times = new Set<number>([ts])
  const files: string[] = []
  if (row) {
    times.add(row.ts)
    if (row.edited !== null) times.add(row.edited)
    files.push(...filesOf(ctx.attachmentsDir, row.attachments))
    const versions = mirror
      .prepare("SELECT rev_ts, attachments FROM edits WHERE author = ? AND ts = ?")
      .all(author, row.ts)
    for (const version of versions as { rev_ts: number; attachments: string | null }[]) {
      times.add(version.rev_ts)
      files.push(...filesOf(ctx.attachmentsDir, version.attachments))
    }
    for (const table of ["edits", "messages"]) {
      mirror.prepare(`DELETE FROM ${table} WHERE author = ? AND ts = ?`).run(author, row.ts)
    }
  }
  const dropReactions = mirror.prepare("DELETE FROM reactions WHERE author = ? AND ts = ?")
  // A quote names its message by author and time (of any revision); one without an author only within the chat.
  const unquote = mirror.prepare(
    `UPDATE messages SET quote = NULL
     WHERE quote IS NOT NULL AND json_extract(quote, '$.id') = ?
       AND (json_extract(quote, '$.author') = ? OR (json_extract(quote, '$.author') IS NULL AND chat = ?))`,
  )
  for (const time of times) {
    dropReactions.run(author, time)
    unquote.run(time, author, row?.chat ?? null)
  }
  recordDeleted(mirror, author, times, ctx.now)
  return row ? [...new Set(files)] : null
}
