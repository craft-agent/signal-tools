/** What ingesting an envelope needs to know about the account and the moment. */
export type IngestContext = {
  /** This account's own id (UUID). */
  me: string
  /** signal-cli's directory of received attachments. */
  attachmentsDir: string
  /** When the envelope was received, in milliseconds. */
  now: number
}

/** What ingesting an envelope did, and the files the caller removes once the transaction has committed. */
export type IngestResult = {
  /** What was done, as log kinds: never content, ids or numbers. */
  done: string[]
  /** Absolute paths inside the attachments directory, of the files of messages that were deleted. */
  removeFiles: string[]
}

/** Adds what `other` did and its files to `result`. */
export function absorb(result: IngestResult, other: IngestResult): void {
  result.done.push(...other.done)
  result.removeFiles.push(...other.removeFiles)
}
