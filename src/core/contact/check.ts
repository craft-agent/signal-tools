import { ToolError } from "../errors"
import { callDaemon, isDaemonNotRunning, syncServiceNotRunning } from "../signal/daemon"
import { isRecord } from "../signal/daemon-errors"
import { accountId } from "../signal/ids"
import type { LabelPaths } from "../signal/labels"

const MAX_NUMBERS = 3
const CHECK_TIMEOUT_MS = 45_000
const NUMBER_PATTERN = /^\+[1-9][0-9]{6,14}$/
const NOTE =
  "Not found also means the person hid their number from search, or Signal limited lookups for now. A found number's chat id can be used at once; it appears among the contacts after the sync service next refreshes them."

function stripSeparators(value: string): string {
  return value.replace(/[ .()\-]/g, "")
}

function normalizeNumbers(given: string[] | undefined): string[] {
  if (!given?.length) throw new ToolError("invalid_argument", "numbers must contain one to three phone numbers.")
  if (given.length > MAX_NUMBERS) {
    throw new ToolError(
      "invalid_argument",
      "Check at most three numbers: signal-cli turns a lookup of more than three numbers into a lookup of every number it knows, using up Signal's lookup allowance.",
    )
  }
  return [
    ...new Set(
      given.map((value, index) => {
        const number = stripSeparators(value)
        if (!NUMBER_PATTERN.test(number)) {
          throw new ToolError(
            "invalid_argument",
            `numbers entry ${index + 1} must be + followed by 7 to 15 digits, the first not 0.`,
          )
        }
        return number
      }),
    ),
  ]
}

export async function checkNumbers(paths: LabelPaths, given: string[] | undefined, signal?: AbortSignal) {
  const numbers = normalizeNumbers(given)
  let result: unknown
  try {
    result = await callDaemon(
      paths.socket,
      "getUserStatus",
      { recipient: numbers },
      { effect: "read", timeoutMs: CHECK_TIMEOUT_MS, signal },
    )
  } catch (error) {
    if (isDaemonNotRunning(error)) throw syncServiceNotRunning(error)
    throw error
  }
  const entries = Array.isArray(result)
    ? result.filter(isRecord).map((entry) => ({
        uuid: entry.uuid,
        isRegistered: entry.isRegistered,
        number: typeof entry.number === "string" ? stripSeparators(entry.number) : undefined,
        recipient: typeof entry.recipient === "string" ? stripSeparators(entry.recipient) : undefined,
      }))
    : []
  return {
    numbers: numbers.map((number) => {
      const found = entries.find((entry) => entry.number === number || entry.recipient === number)
      const uuid = found?.isRegistered === true ? accountId(found.uuid) : null
      return { number, on_signal: uuid !== null, ...(uuid ? { chat: uuid } : {}) }
    }),
    note: NOTE,
  }
}
