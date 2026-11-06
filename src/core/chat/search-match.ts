import { ToolError } from "../errors"
import { foldCase } from "../fold"
import type { StoredAttachment } from "../signal/mirror-parts"
import { readList, type StoredMessage } from "./message-rows"

/**
 * The words of a search query, folded (see `foldCase`) and without repeats.
 * A query with no word, or none at all, is `invalid_argument`.
 */
export function searchWords(query: string | undefined): string[] {
  if (query === undefined) {
    throw new ToolError("invalid_argument", "query is required for search: give the words to look for.")
  }
  const words = foldCase(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    throw new ToolError("invalid_argument", "query must not be blank: give the words to look for.")
  }
  return [...new Set(words)]
}

/**
 * The texts of a message a search looks in, folded: its text, and each file's
 * name and caption. Earlier versions, quoted text, reactions and the names
 * behind mentions are not searched.
 */
function searchableTexts(row: StoredMessage): string[] {
  const texts: string[] = []
  if (row.body) texts.push(foldCase(row.body))
  for (const file of readList<StoredAttachment>(row.attachments)) {
    if (file.name) texts.push(foldCase(file.name))
    if (file.caption) texts.push(foldCase(file.caption))
  }
  return texts
}

/** Whether every word is in one of the message's searchable texts; the words may sit in different ones. */
export function matchesAllWords(row: StoredMessage, words: readonly string[]): boolean {
  const texts = searchableTexts(row)
  return words.every((word) => texts.some((text) => text.includes(word)))
}
