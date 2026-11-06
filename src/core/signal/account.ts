import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../errors"
import { isRecord } from "./daemon-errors"
import { accountId } from "./ids"
import type { LabelPaths } from "./labels"
import { ACCOUNT_UUID_META } from "./mirror-meta"

export { ACCOUNT_UUID_META }

/** Where signal-cli keeps its accounts inside its `--config` directory. */
const DATA_DIR = "data"
const ACCOUNTS_FILE = "accounts.json"

const SEVERAL_ACCOUNTS = "signal-cli holds more than one account in this label's directory."

/**
 * The account signal-cli holds in a label's directory.
 *
 * `number` is only for signal-cli's `-a` argument: it must never reach a
 * result, an error or a log.
 */
export type LinkedAccount = {
  /** The account id, or null when signal-cli wrote none that is a UUID. */
  uuid: string | null
  number: string
  /** Whether Signal still knows this device; false once it was unlinked, null when the file does not say. */
  registered: boolean | null
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/** Whether `value` is a plain file name, which cannot lead out of the data directory. */
function isPlainFileName(value: unknown): value is string {
  return (
    typeof value === "string" && value !== "" && !value.includes("/") && !value.includes("\\") && !value.startsWith(".")
  )
}

/**
 * The linked account of a label, or null when the directory holds none or
 * its files are missing, unreadable or malformed. More than one account is
 * `upstream_error`: a label is one linked device.
 */
export function readLinkedAccount(paths: LabelPaths): LinkedAccount | null {
  const dataDir = join(paths.signalCli, DATA_DIR)
  const index = readJson(join(dataDir, ACCOUNTS_FILE))
  if (!isRecord(index) || !Array.isArray(index.accounts) || index.accounts.length === 0) return null
  if (index.accounts.length > 1) throw new ToolError("upstream_error", SEVERAL_ACCOUNTS)

  const entry: unknown = index.accounts[0]
  if (!isRecord(entry) || typeof entry.number !== "string" || entry.number === "" || !isPlainFileName(entry.path)) {
    return null
  }
  const keys = readJson(join(dataDir, entry.path))
  if (!isRecord(keys)) return null
  return {
    uuid: accountId(entry.uuid),
    number: entry.number,
    registered: typeof keys.registered === "boolean" ? keys.registered : null,
  }
}
