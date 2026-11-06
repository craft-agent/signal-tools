import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ingestEnvelope, removeFiles, type IngestContext, type IngestResult } from "./ingest"
import { inTransaction, openMirrorForWrite, type Mirror } from "./mirror"

/** Made-up accounts, group ids and number for tests. */
export const ME = "11111111-1111-4111-8111-111111111111"
export const ALICE = "22222222-2222-4222-8222-222222222222"
export const BOB = "33333333-3333-4333-8333-333333333333"
export const GROUP_ID = `${"G".repeat(43)}=`
export const OTHER_GROUP_ID = `${"H".repeat(43)}=`
export const NUMBER = "+15555550123"

/** A fixed time for tests, in milliseconds. */
export const NOW = 1_800_000_000_000

/** A mirror in a fresh temp directory, with the attachments directory beside it. */
export type TestMirror = {
  dir: string
  path: string
  attachmentsDir: string
  mirror: Mirror
  /** The ingest context of this account, received at `now`. */
  ctx(now?: number): IngestContext
  /** Ingests payloads, each in a transaction, received at `NOW`, removing the files it returns after the commit; returns what each did. */
  ingest(...payloads: unknown[]): string[][]
  /** The same for one payload, received at `now`. */
  ingestAt(now: number, payload: unknown): string[]
  /** Ingests one payload in a committed transaction and leaves its files for the test to remove. */
  ingestKeepingFiles(payload: unknown): IngestResult
  /** Closes the mirror and removes the directory. */
  close(): void
}

/** Where a test keeps files in a fresh, short temp directory; remove it with `rmSync`. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sig-"))
}

/** Opens a new mirror for writing in a temp directory. */
export function createTestMirror(): TestMirror {
  const dir = makeTempDir()
  const path = join(dir, "mirror.sqlite")
  const attachmentsDir = join(dir, "attachments")
  mkdirSync(attachmentsDir)
  const mirror = openMirrorForWrite(path)
  const ctx = (now = NOW): IngestContext => ({ me: ME, attachmentsDir, now })
  const ingestKeepingFiles = (payload: unknown) => inTransaction(mirror, () => ingestEnvelope(mirror, payload, ctx()))
  const ingestAt = (now: number, payload: unknown) => {
    const result = inTransaction(mirror, () => ingestEnvelope(mirror, payload, ctx(now)))
    removeFiles(result.removeFiles)
    return result.done
  }
  return {
    dir,
    path,
    attachmentsDir,
    mirror,
    ctx,
    ingest: (...payloads) => payloads.map((payload) => ingestAt(NOW, payload)),
    ingestAt,
    ingestKeepingFiles,
    close() {
      mirror.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The error a function throws, for a test that checks it; fails when it returns. */
export function errorOf(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the function to throw")
}

/** The rows of a query, for a test to check. */
export function rowsOf(mirror: Mirror, sql: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
  return mirror.prepare(sql).all(...params) as Record<string, unknown>[]
}

/** The first column of every row of a query. */
export function columnOf(mirror: Mirror, sql: string, ...params: (string | number | null)[]): unknown[] {
  return rowsOf(mirror, sql, ...params).map((row) => Object.values(row)[0])
}

/** The stored message of `author` at `ts`, or undefined. */
export function messageRow(mirror: Mirror, author: string, ts: number): Record<string, unknown> | undefined {
  return rowsOf(mirror, "SELECT * FROM messages WHERE author = ? AND ts = ?", author, ts)[0]
}

/** A `receive` result for an envelope from `source`, with the fields of the envelope after it. */
export function envelopeFrom(
  source: string | undefined,
  fields: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return { account: NUMBER, envelope: { sourceUuid: source, sourceNumber: null, timestamp: NOW, ...extra, ...fields } }
}

/** An incoming data message from `source`; `sent` is its time. */
export function dataFrom(source: string, sent: number, message: Record<string, unknown>, extra = {}) {
  return envelopeFrom(source, { dataMessage: { timestamp: sent, ...message } }, extra)
}

/** An incoming data message to a group. */
export function groupDataFrom(source: string, sent: number, message: Record<string, unknown>, groupId = GROUP_ID) {
  return dataFrom(source, sent, { groupInfo: { groupId, type: "DELIVER" }, ...message })
}

/** An incoming edit by `source` of the message at `target`, whose new version is stamped `edited`. */
export function editFrom(source: string, target: number, edited: number, message: Record<string, unknown>) {
  return envelopeFrom(source, {
    editMessage: { targetSentTimestamp: target, dataMessage: { timestamp: edited, ...message } },
  })
}

/** An incoming delete for everyone by `source` of the message at `target`. */
export function deleteFrom(source: string, target: number) {
  return dataFrom(source, target + 1, { remoteDelete: { timestamp: target } })
}

/** An incoming reaction by `source` to the message of `author` at `target`. */
export function reactionFrom(source: string, target: number, author: string, emoji: string, isRemove = false) {
  return dataFrom(source, target + 5, {
    reaction: { emoji, targetAuthorUuid: author, targetSentTimestamp: target, isRemove },
  })
}

/** A sync message from another device of this account. */
export function syncFromMe(sync: Record<string, unknown>) {
  return envelopeFrom(ME, { syncMessage: sync })
}

/** A sent transcript to `destination`; `sent` is its time. */
export function sentTo(destination: string, sent: number, message: Record<string, unknown>) {
  return syncFromMe({ sentMessage: { destinationUuid: destination, timestamp: sent, ...message } })
}
