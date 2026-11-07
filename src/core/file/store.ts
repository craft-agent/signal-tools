import type { FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { ATTACHMENT_ID } from "./constants"
import { openForRead } from "./fs-safe"

/**
 * Opens one file of signal-cli's attachment store by its id, and nothing
 * else: an id that is not a plain file name is never turned into a path, a
 * link in the store is not followed, and what is there must be a regular file.
 * Resolves to `undefined` for anything the store does not hold in that form;
 * the path never appears in an error.
 */
export async function openFromStore(storeDir: string, id: string | undefined): Promise<FileHandle | undefined> {
  if (id === undefined || !ATTACHMENT_ID.test(id)) return undefined
  let file: FileHandle
  try {
    file = await openForRead(join(storeDir, id))
  } catch {
    return undefined
  }
  try {
    if ((await file.stat()).isFile()) return file
  } catch {
    // treated as not readable, below
  }
  await file.close()
  return undefined
}
