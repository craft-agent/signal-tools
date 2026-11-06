import { cutText, type Cuttable } from "../pages"
import { OMITTABLE_FIELDS, type MessageEntry } from "./message-schema"

/**
 * The texts of a message in the order they are cut from the end: the text, the
 * file captions, the quoted text, then the earlier versions.
 */
function texts(entry: MessageEntry): string[] {
  return [
    entry.text ?? "",
    ...(entry.files ?? []).map((file) => file.caption ?? ""),
    entry.reply_to?.text ?? "",
    ...(entry.earlier_versions ?? []).map((version) => version.text),
  ]
}

/** How many characters of text a message carries, which is how much `cutMessage` can take from it. */
export function messageTextLength(entry: MessageEntry): number {
  return texts(entry).reduce((total, text) => total + text.length, 0)
}

/**
 * The message keeping `keep` characters of its texts, the earliest in the
 * order of `texts` first, and `text_cut` set when any lost something.
 */
export function cutMessage(entry: MessageEntry, keep: number): MessageEntry {
  let room = keep
  let cut = false
  const take = (text: string): string => {
    const kept = cutText(text, room)
    room = Math.max(0, room - text.length)
    if (kept.length < text.length) cut = true
    return kept
  }
  const cutEntry: MessageEntry = { ...entry }
  if (entry.text !== undefined) cutEntry.text = take(entry.text)
  if (entry.files)
    cutEntry.files = entry.files.map((file) =>
      file.caption === undefined ? file : { ...file, caption: take(file.caption) },
    )
  if (entry.reply_to?.text != null) cutEntry.reply_to = { ...entry.reply_to, text: take(entry.reply_to.text) }
  if (entry.earlier_versions)
    cutEntry.earlier_versions = entry.earlier_versions.map((version) => ({ ...version, text: take(version.text) }))
  if (cut) cutEntry.text_cut = true
  return cutEntry
}

/**
 * The message without the next of `OMITTABLE_FIELDS` it still has, marked
 * `text_cut` and listing what was dropped under `omitted`; dropped files stay
 * counted as `files_omitted`. Null when none is left to drop.
 */
export function dropMetadata(entry: MessageEntry): MessageEntry | null {
  const field = OMITTABLE_FIELDS.find((name) => entry[name] !== undefined)
  if (field === undefined) return null
  const { [field]: dropped, ...rest } = entry
  const next: MessageEntry = { ...rest, text_cut: true, omitted: [...(entry.omitted ?? []), field] }
  if (field === "files") next.files_omitted = (dropped as unknown[]).length
  return next
}

/** How a message that alone exceeds a result's budget is cut. */
export const cuttableMessage: Cuttable<MessageEntry> = {
  size: messageTextLength,
  cut: cutMessage,
  drop: dropMetadata,
}
