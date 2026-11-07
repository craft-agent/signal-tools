import { inspectArchive, type ArchiveListing } from "../archive/inspect"
import { classifyFile, type ArchiveFormat } from "../archive/kind"
import type { ArchiveLimits } from "../archive/limits"
import { ArchiveRefused } from "../archive/refused"
import type { SourceFile } from "./message-files"
import { copyToPartial, discard, placeFile, type Placed } from "./place"
import { openFromStore } from "./store"

/** What became of one file of the message. */
export type SaveOutcome =
  | { kind: "missing" }
  | { kind: "refused"; reason: string }
  | {
      kind: "saved"
      placed: Placed
      size: number
      sha256: string
      /** Set when the file is an archive that passed inspection. */
      archive?: { format: ArchiveFormat; listing: ArchiveListing }
    }

/**
 * Saves one file of a message into its folder: copies it out of the store into
 * a private partial while taking its SHA-256, judges the copy by its name,
 * declared type and first bytes (a program or an installer is removed again),
 * inspects it when it is an archive (a refused one is removed again), and only
 * then places it under `name` without overwriting anything. A file the store
 * does not hold is `missing`. The partial is gone whatever happens.
 */
export async function saveOne(
  source: SourceFile,
  name: string,
  storeDir: string,
  folder: string,
  signal?: AbortSignal,
  limits?: ArchiveLimits,
): Promise<SaveOutcome> {
  const handle = await openFromStore(storeDir, source.id)
  if (handle === undefined) return { kind: "missing" }
  const copied = await copyToPartial(handle, folder, signal).finally(() => handle.close())
  try {
    const kind = classifyFile({ name, type: source.type, head: copied.head })
    if (kind.kind === "refused") {
      await discard(copied.partial)
      return { kind: "refused", reason: kind.reason }
    }
    let archive: Extract<SaveOutcome, { kind: "saved" }>["archive"]
    if (kind.kind === "archive") {
      try {
        archive = { format: kind.format, listing: await inspectArchive(copied.partial, kind.format, limits, signal) }
      } catch (error) {
        if (!(error instanceof ArchiveRefused)) throw error
        await discard(copied.partial)
        return { kind: "refused", reason: error.message }
      }
    }
    const placed = await placeFile(copied, folder, name)
    return { kind: "saved", placed, size: copied.size, sha256: copied.sha256, ...(archive && { archive }) }
  } catch (error) {
    await discard(copied.partial)
    throw error
  }
}
