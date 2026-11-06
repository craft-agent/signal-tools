import { isRecord } from "./daemon-errors"
import { GROUP_ID_PATTERN, accountId, groupChat } from "./ids"
import type { Mirror } from "./mirror"
import { intOrNull, textOrNull, toJson, type StoredAttachment, type StoredQuote } from "./mirror-parts"
import { touchChat } from "./mirror-rows"

/** The non-empty parts of a name, joined with spaces; null when none. */
function joinName(...parts: unknown[]): string | null {
  const words = parts.filter((part): part is string => typeof part === "string" && part !== "")
  return words.length > 0 ? words.join(" ") : null
}

/** The name the user knows a contact by: their own nickname, else the contact card's name, else any name signal-cli has. */
function personName(contact: Record<string, unknown>): string | null {
  return (
    joinName(contact.nickGivenName, contact.nickFamilyName) ??
    joinName(contact.givenName, contact.familyName) ??
    textOrNull(contact.nickName) ??
    textOrNull(contact.name)
  )
}

/**
 * Stores the contacts of the daemon's `listContacts` (with all recipients). A
 * contact keeps the number and profile name it had when the daemon gives none.
 * Returns how many contacts were stored; entries without an account id are skipped.
 */
export function upsertContacts(mirror: Mirror, contacts: unknown, now: number): number {
  if (!Array.isArray(contacts)) return 0
  const upsert = mirror.prepare(
    `INSERT INTO contacts (uuid, number, name, profile_name, username, blocked, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (uuid) DO UPDATE SET
       number = COALESCE(excluded.number, contacts.number), name = excluded.name,
       profile_name = COALESCE(excluded.profile_name, contacts.profile_name),
       username = excluded.username, blocked = excluded.blocked, updated = excluded.updated`,
  )
  const setExpiry = mirror.prepare("UPDATE chats SET expires_in = ? WHERE id = ?")
  let count = 0
  for (const contact of contacts as unknown[]) {
    if (!isRecord(contact)) continue
    const uuid = accountId(contact.uuid)
    if (!uuid) continue
    const profile = isRecord(contact.profile) ? contact.profile : {}
    upsert.run(
      uuid,
      textOrNull(contact.number),
      personName(contact),
      joinName(profile.givenName, profile.familyName),
      textOrNull(contact.username),
      Number(Boolean(contact.isBlocked)),
      now,
    )
    const expires = intOrNull(contact.messageExpirationTime)
    if (expires !== null) setExpiry.run(expires, uuid)
    count += 1
  }
  return count
}

/**
 * Stores the groups of the daemon's `listGroups`, with their members' account
 * ids. Returns how many groups were stored; entries with a malformed id are skipped.
 */
export function upsertGroups(mirror: Mirror, groups: unknown, now: number): number {
  if (!Array.isArray(groups)) return 0
  const upsert = mirror.prepare(
    `INSERT INTO chats (id, kind, name, members, member, expires_in, updated) VALUES (?, 'group', ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, members = excluded.members, member = excluded.member,
       expires_in = excluded.expires_in, updated = excluded.updated`,
  )
  let count = 0
  for (const group of groups as unknown[]) {
    if (!isRecord(group)) continue
    const { id } = group
    if (typeof id !== "string" || !GROUP_ID_PATTERN.test(id)) continue
    const members = (Array.isArray(group.members) ? (group.members as unknown[]) : []).flatMap((member) => {
      const uuid = isRecord(member) ? accountId(member.uuid) : null
      return uuid ? [uuid] : []
    })
    upsert.run(
      groupChat(id),
      textOrNull(group.name),
      JSON.stringify(members),
      Number(group.isMember !== false),
      intOrNull(group.messageExpirationTime),
      now,
    )
    count += 1
  }
  return count
}

/**
 * Remembers the number of an account, learned from a number check. It is fresh
 * from Signal, so it wins: another contact that had the number loses it.
 * Anything that is not a number or an account id is ignored.
 */
export function rememberNumber(mirror: Mirror, number: string, uuid: string, now: number): void {
  const id = accountId(uuid)
  if (!id || !number) return
  mirror.prepare("UPDATE contacts SET number = NULL WHERE number = ? AND uuid != ?").run(number, id)
  mirror
    .prepare(
      `INSERT INTO contacts (uuid, number, updated) VALUES (?, ?, ?)
       ON CONFLICT (uuid) DO UPDATE SET number = excluded.number, updated = excluded.updated`,
    )
    .run(id, number, now)
}

/** What a send through the tools leaves in the mirror once Signal accepted it. */
export type SentMessage = {
  chat: string
  /** This account's own id. */
  me: string
  /** The sent time in milliseconds. */
  ts: number
  body: string | null
  attachments: readonly StoredAttachment[]
  quote: StoredQuote | null
  now: number
}

/** Records a message this device sent: signal-cli does not report its own sends back. */
export function recordSent(mirror: Mirror, sent: SentMessage): void {
  const { chat, me, ts, body, attachments, quote, now } = sent
  const row = mirror.prepare("SELECT expires_in FROM chats WHERE id = ?").get(chat) as
    { expires_in: number | null } | undefined
  const expires = row?.expires_in ?? 0
  touchChat(mirror, chat, ts, now)
  mirror
    .prepare(
      `INSERT OR IGNORE INTO messages (chat, author, ts, from_me, body, attachments, quote, expires_in, expire_start, received)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(chat, me, ts, body, toJson(attachments), toJson(quote), expires, expires > 0 ? ts : null, now)
}
