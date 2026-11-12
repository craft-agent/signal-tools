import type { StoredMention } from "../signal/mirror-parts"
import { OWN_NAME, type People } from "./people"

/** What Signal puts in the text where a mention sits; the mention's range names who. */
const MENTION_PLACEHOLDER = "\uFFFC"

/** Who a mention names, as `@name` reads: `me` for the user, the contact's name, else the number or the account id. */
function mentionName({ uuid, number }: StoredMention, people: People): string | null {
  if (uuid !== undefined) return uuid === people.me ? OWN_NAME : (people.displayName(uuid) ?? uuid)
  if (number === undefined) return null
  return people.isOwnNumber(number) ? OWN_NAME : number
}

/**
 * The text with each mention written as `@name`. Mentions are ranges into the
 * text, each at a placeholder character; a range that does not sit on one, or
 * that names nobody, leaves the text as it was.
 */
export function renderMentions(text: string, mentions: readonly StoredMention[], people: People): string {
  return replaceMentions(text, mentions, (mention) => mentionName(mention, people))
}

/** The text with mentions named for an approval prompt: `me` for the user, a known name, else `?`, never a number or account id. Load the mention uuids into `people` first. */
export function promptMentions(text: string, mentions: readonly StoredMention[], people: People): string {
  return replaceMentions(text, mentions, ({ uuid, number }) => {
    if (uuid !== undefined) return uuid === people.me ? OWN_NAME : (people.name(uuid) ?? "?")
    return number !== undefined && people.isOwnNumber(number) ? OWN_NAME : "?"
  })
}

/** Replaces mention placeholders with the names `nameOf` supplies, leaving invalid ranges and unnamed mentions as they were. */
function replaceMentions(
  text: string,
  mentions: readonly StoredMention[],
  nameOf: (mention: StoredMention) => string | null,
): string {
  if (mentions.length === 0 || !text.includes(MENTION_PLACEHOLDER)) return text
  let out = ""
  let from = 0
  for (const mention of mentions) {
    if (mention.start < from || text[mention.start] !== MENTION_PLACEHOLDER) continue
    const name = nameOf(mention)
    if (name === null) continue
    out += `${text.slice(from, mention.start)}@${name}`
    from = mention.start + 1
  }
  return out + text.slice(from)
}
