import { closeSync, openSync, rmSync, writeSync } from "node:fs"
import { isAlive, readPid } from "./sync-wait"

/** Owner read and write only, like the rest of the label's state. */
const LOCK_MODE = 0o600

/** Why a run does not start when another holds the label's lock. */
export const LOCK_HELD_REASON = "another sync service is already running for this account"

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST"
}

/**
 * Takes the exclusive lock of a label's sync service: a file holding this
 * process's id, created only if it does not exist. A lock whose process is
 * gone (or whose content is unreadable) is taken over.
 *
 * Returns the function that releases the lock, or undefined when another
 * live process holds it.
 */
export function acquireSyncLock(path: string): (() => void) | undefined {
  // Two tries: the second follows the removal of a lock nobody holds, and loses only to a run that took it first.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", LOCK_MODE)
      try {
        writeSync(fd, `${process.pid}\n`)
      } catch (error) {
        rmSync(path, { force: true })
        throw error
      } finally {
        closeSync(fd)
      }
      return () => {
        if (readPid(path) === process.pid) rmSync(path, { force: true })
      }
    } catch (error) {
      if (!isEexist(error)) throw error
    }
    const holder = readPid(path)
    if (holder !== undefined && holder !== process.pid && isAlive(holder)) return undefined
    rmSync(path, { force: true })
  }
  return undefined
}
