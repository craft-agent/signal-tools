import { lstat, rm } from "node:fs/promises"
import { ToolError } from "../errors"
import { isWithin } from "../paths"
import { checkLabel, labelPaths, listLabels } from "./labels"
import { isAlive, readPid } from "./sync-wait"

/** How long removal waits for a running daemon process to exit. */
const DEFAULT_POLL_TIMEOUT_MS = 5_000

/** How often removal checks whether the daemon process is still alive. */
const DEFAULT_POLL_INTERVAL_MS = 100

export type RemoveLabelOptions = {
  /** The state directory containing label state subdirectories. */
  stateDir: string
  /** The account label to remove. */
  label: string
  /** Callback to stop and uninstall the service definition before removal. */
  uninstall: () => Promise<void>
  /** Maximum time in ms to wait for the daemon process to exit. Defaults to 5000 ms. */
  pollTimeoutMs?: number
  /** Interval in ms between checks for the daemon process. Defaults to 100 ms. */
  pollIntervalMs?: number
}

/** Whether any of the pid files names a live process. */
function holdsLivePid(pidFiles: string[]): boolean {
  return pidFiles.some((path) => {
    const pid = readPid(path)
    return pid !== undefined && isAlive(pid)
  })
}

/**
 * Permanently removes a label and its entire state directory.
 *
 * Checks that the label exists and is not a symlink, uninstalls the service,
 * waits for any running daemon or sync service process to stop, and
 * recursively deletes the label directory.
 */
export async function removeLabel(options: RemoveLabelOptions): Promise<void> {
  const { stateDir, label, uninstall } = options
  checkLabel(label)

  const paths = labelPaths(stateDir, label)

  const initialStat = await lstat(paths.dir).catch(() => undefined)
  if (initialStat && (initialStat.isSymbolicLink() || !initialStat.isDirectory())) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" is not a directory.`)
  }

  const labels = await listLabels(stateDir)
  if (!labels.includes(label)) {
    const known = labels.length > 0 ? `known accounts: ${labels.join(", ")}.` : "no Signal account is linked yet."
    throw new ToolError("not_found", `Signal account "${label}" was not found; ${known}`)
  }

  await uninstall()

  const timeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const start = Date.now()

  while (holdsLivePid([paths.daemonPid, paths.syncLock])) {
    if (Date.now() - start >= timeoutMs) {
      throw new ToolError("invalid_argument", "The sync service for this label is still running; stop it first.")
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, timeoutMs - (Date.now() - start))))
  }

  const finalStat = await lstat(paths.dir).catch(() => undefined)
  if (!finalStat || finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" is not a directory.`)
  }

  if (!(await isWithin(paths.dir, stateDir))) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" is not inside state directory.`)
  }

  await rm(paths.dir, { recursive: true, force: true })
}
