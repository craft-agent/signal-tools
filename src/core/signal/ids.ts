/** An account id as signal-cli writes it: 8-4-4-4-12 lowercase hexadecimal digits. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A group id as signal-cli writes it: base64, 42 or 43 characters and up to two `=`. */
export const GROUP_ID_PATTERN = /^[A-Za-z0-9+/]{42,43}={0,2}$/

/** What starts the chat id of a group: `group:<group id>`. */
export const GROUP_PREFIX = "group:"

/** The account id in `value`, lowercased, or null when `value` is not a UUID. */
export function accountId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const id = value.toLowerCase()
  return UUID_PATTERN.test(id) ? id : null
}

/** The chat id of a group. */
export function groupChat(groupId: string): string {
  return GROUP_PREFIX + groupId
}

/** Whether a chat id names a group. */
export function isGroupChat(chat: string): boolean {
  return chat.startsWith(GROUP_PREFIX)
}

/** A message's sent time as its id writes it: a positive whole number of milliseconds, up to 16 digits. */
const MESSAGE_TIME_PATTERN = /^[1-9][0-9]{0,15}$/

/** The id of a message: its author's account id and its sent time in milliseconds, `<uuid>:<ms>`. */
export function messageId(author: string, ts: number): string {
  return `${author}:${ts}`
}

/** The author and sent time in a message id, or null when `text` is not one (the account id must be lowercase). */
export function parseMessageId(text: string): { author: string; ts: number } | null {
  if (typeof text !== "string") return null
  const parts = text.split(":")
  const [author, time] = parts
  if (parts.length !== 2 || author === undefined || time === undefined) return null
  if (!UUID_PATTERN.test(author) || !MESSAGE_TIME_PATTERN.test(time)) return null
  const ts = Number(time)
  return Number.isSafeInteger(ts) ? { author, ts } : null
}

/** Whether `text` is a chat id: a person's account id (lowercase) or `group:<group id>`. Names and numbers are not. */
export function isChatId(text: string): boolean {
  if (typeof text !== "string") return false
  return isGroupChat(text) ? GROUP_ID_PATTERN.test(text.slice(GROUP_PREFIX.length)) : UUID_PATTERN.test(text)
}
