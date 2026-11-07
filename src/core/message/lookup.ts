import { ToolError } from "../errors"
import type { Mirror } from "../signal/mirror"
import { hasDisappeared, isDeleted } from "../signal/mirror-rows"
import { GONE_MESSAGE, UNKNOWN_MESSAGE } from "./constants"

type LiveColumns = {
  kind: "message" | "timer"
  expires_in: number
  expire_start: number | null
}

/**
 * The stored message of `chat` that `reference` names, with `columns` besides
 * the ones that tell whether it is still there. A message of another chat, an
 * unknown one and a timer change are `not_found` alike; so is one deleted for
 * everyone or expired, saying it is gone. `columns` are constants of the
 * caller, never text from a call.
 */
export function findLiveRow<Row extends object>(
  mirror: Mirror,
  chat: string,
  reference: { author: string; ts: number },
  columns: string,
  now: number,
): Row & LiveColumns {
  const row = mirror
    .prepare(`SELECT kind, expires_in, expire_start, ${columns} FROM messages WHERE chat = ? AND author = ? AND ts = ?`)
    .get(chat, reference.author, reference.ts) as (Row & LiveColumns) | undefined
  if (!row || row.kind === "timer") {
    throw new ToolError("not_found", isDeleted(mirror, reference.author, reference.ts) ? GONE_MESSAGE : UNKNOWN_MESSAGE)
  }
  if (hasDisappeared(row, now)) throw new ToolError("not_found", GONE_MESSAGE)
  return row
}
