import { Buffer } from "node:buffer"
import { z } from "zod"
import { excludedCondition } from "../chat/excluded"
import { fingerprint } from "../chat/filter"
import { ToolError } from "../errors"
import { foldCase } from "../fold"
import { UUID_PATTERN } from "../signal/ids"
import type { LabelPaths } from "../signal/labels"
import { getMeta, openMirrorForRead } from "../signal/mirror"
import { ACCOUNT_UUID_META } from "../signal/mirror-meta"
import { CONTACT_NAMES_NOTE, CONTACT_TOOL_ID } from "./constants"
import type { contact } from "./read"

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 200
const cursorShape = z.strictObject({
  tool: z.literal(CONTACT_TOOL_ID),
  account: z.string(),
  query: z.string(),
  sort: z.string(),
  uuid: z.string().regex(UUID_PATTERN),
  excluded: z.string().optional(),
})

type ContactRow = {
  uuid: string
  name: string | null
  profile_name: string | null
  number: string | null
  username: string | null
  blocked: number
}

function displayName(row: ContactRow): string | null {
  return row.name || row.profile_name || row.username || row.number || null
}

/**
 * A digest of the excluded chats in a fixed order, so a cursor binds the set and not the order it was given in,
 * without carrying the ids to whoever reads the cursor; absent when empty.
 */
function excludedKey(excluded: ReadonlySet<string>): string | undefined {
  return excluded.size === 0 ? undefined : fingerprint([...excluded].sort())
}

function cursorOf(
  cursor: string | undefined,
  account: string,
  query: string,
  excluded: ReadonlySet<string>,
): z.infer<typeof cursorShape> | undefined {
  if (cursor === undefined) return undefined
  try {
    const decoded = Buffer.from(cursor, "base64url")
    if (decoded.toString("base64url") !== cursor) throw new Error()
    const value = cursorShape.parse(JSON.parse(decoded.toString("utf8")))
    if (value.account !== account || value.query !== query || value.excluded !== excludedKey(excluded)) {
      throw new Error()
    }
    return value
  } catch {
    throw new ToolError("invalid_argument", "cursor is not a cursor this tool returned.")
  }
}

function entry(row: ContactRow): z.infer<typeof contact> {
  const name = displayName(row)
  return {
    chat: row.uuid,
    name,
    ...(row.profile_name && row.profile_name !== name ? { profile_name: row.profile_name } : {}),
    ...(row.number ? { number: row.number } : {}),
    ...(row.username ? { username: row.username } : {}),
    ...(row.blocked ? { blocked: true as const } : {}),
  }
}

export function listContacts(
  paths: LabelPaths,
  args: { query?: string; limit?: number; cursor?: string },
  excluded: ReadonlySet<string>,
) {
  const query = foldCase(args.query ?? "")
  const cursor = cursorOf(args.cursor, paths.label, query, excluded)
  const condition = excludedCondition("uuid", excluded)
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const mirror = openMirrorForRead(paths.mirror)
  try {
    const me = getMeta(mirror)[ACCOUNT_UUID_META]
    const rows = (
      mirror
        .prepare(
          `SELECT uuid, name, profile_name, number, username, blocked FROM contacts${condition ? ` WHERE ${condition.sql}` : ""}`,
        )
        .all(...(condition?.params ?? [])) as ContactRow[]
    )
      .filter(
        (row) =>
          row.uuid !== me &&
          [row.name, row.profile_name, row.number, row.username].some((value) => foldCase(value ?? "").includes(query)),
      )
      .map((row) => ({ row, sort: foldCase(displayName(row) ?? "") }))
      .filter(
        ({ row, sort }) =>
          cursor === undefined || sort > cursor.sort || (sort === cursor.sort && row.uuid > cursor.uuid),
      )
      .sort((a, b) =>
        a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.row.uuid < b.row.uuid ? -1 : a.row.uuid > b.row.uuid ? 1 : 0,
      )
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      contacts: page.map(({ row }) => entry(row)),
      ...(last && page.length < rows.length
        ? {
            next: Buffer.from(
              JSON.stringify({
                tool: CONTACT_TOOL_ID,
                account: paths.label,
                query,
                sort: last.sort,
                uuid: last.row.uuid,
                excluded: excludedKey(excluded),
              }),
            ).toString("base64url"),
          }
        : {}),
      note: CONTACT_NAMES_NOTE,
    }
  } finally {
    mirror.close()
  }
}
