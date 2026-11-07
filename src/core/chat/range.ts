import { parseTimeArgument } from "../time"

/** Exclusive bounds on a message's sent time, in milliseconds. */
export type TimeRange = { after?: number; before?: number }

/** Where a scan of messages, newest first, has got to: everything newer than this (time, then author) is behind it. */
export type Position = { ts: number; author: string }

/** The position of a stored message in the keyset order (time, then author). */
export function positionOf(row: { ts: number; author: string }): Position {
  return { ts: row.ts, author: row.author }
}

/** The `after` and `before` arguments as times, or `invalid_argument` naming the one that is not a time. */
export function readRange(args: { after?: string; before?: string }): TimeRange {
  const range: TimeRange = {}
  if (args.after !== undefined) range.after = parseTimeArgument(args.after, "after")
  if (args.before !== undefined) range.before = parseTimeArgument(args.before, "before")
  return range
}

/** SQL conditions on `messages` for a range, and the parameters they take. */
export function rangeConditions(range: TimeRange): { conditions: string[]; params: number[] } {
  const conditions: string[] = []
  const params: number[] = []
  if (range.after !== undefined) {
    conditions.push("ts > ?")
    params.push(range.after)
  }
  if (range.before !== undefined) {
    conditions.push("ts < ?")
    params.push(range.before)
  }
  return { conditions, params }
}

/**
 * The condition for messages older than `position` in the order newest first
 * (time, then author, both descending). As a row value comparison it is one
 * range on an index of (time, author), where the same test written with `OR`
 * would not seek.
 */
export function olderThan(position: Position): { condition: string; params: (string | number)[] } {
  return { condition: "(ts, author) < (?, ?)", params: [position.ts, position.author] }
}
