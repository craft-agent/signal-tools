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

/** Whether `text` is a chat id: a person's account id (lowercase) or `group:<group id>`. Names and numbers are not. */
export function isChatId(text: string): boolean {
  if (typeof text !== "string") return false
  return isGroupChat(text) ? GROUP_ID_PATTERN.test(text.slice(GROUP_PREFIX.length)) : UUID_PATTERN.test(text)
}
