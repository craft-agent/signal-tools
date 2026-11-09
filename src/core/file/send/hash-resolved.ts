import { createHash } from "node:crypto"
import { assertResolvedFile } from "../../outgoing/identity"
import type { ResolvedFile } from "./resolve-files"
import { openResolved } from "./stage"

/** What one read of a resolved file found. */
export type FileDigest = {
  /** The bytes read. */
  size: number
  /** The SHA-256 of those bytes, in lower-case hexadecimal. */
  sha256: string
}

/**
 * Reads a resolved file once, as `stageFile` opens it (without following a
 * link, checked on the descriptor to be the file that was resolved), and
 * returns its size and SHA-256 without keeping a copy. Stops with the
 * signal's `AbortError` when it aborts.
 */
export async function hashResolved({ shown, resolved }: ResolvedFile, signal?: AbortSignal): Promise<FileDigest> {
  const source = await openResolved(resolved, shown)
  try {
    assertResolvedFile(await source.stat({ bigint: true }), resolved.identity, shown)
    const hash = createHash("sha256")
    let size = 0
    for await (const chunk of source.createReadStream({ autoClose: false, start: 0 })) {
      signal?.throwIfAborted()
      hash.update(chunk)
      size += chunk.length
    }
    return { size, sha256: hash.digest("hex") }
  } finally {
    await source.close()
  }
}
