import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { ingestEnvelope, removeFiles } from "./ingest"
import { inTransaction } from "./mirror"
import {
  ALICE,
  columnOf,
  createTestMirror,
  dataFrom,
  envelopeFrom,
  sentTo,
  syncFromMe,
  type TestMirror,
} from "./mirror.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => {
  t.close()
})

function attachmentFile(id: string): string {
  const path = join(t.attachmentsDir, id)
  writeFileSync(path, "data")
  return path
}

function deleteFrom(target: number) {
  return dataFrom(ALICE, target + 1, { remoteDelete: { timestamp: target } })
}

describe("the files of a deleted message", () => {
  test("are returned by the ingest, which leaves them in place until removeFiles runs", () => {
    const current = attachmentFile("current.png")
    const earlier = attachmentFile("earlier.png")
    t.ingest(
      dataFrom(ALICE, 1000, { message: "v1", attachments: [{ id: "earlier.png" }] }),
      envelopeFrom(ALICE, {
        editMessage: {
          targetSentTimestamp: 1000,
          dataMessage: { timestamp: 1100, message: "v2", attachments: [{ id: "current.png" }, { id: "earlier.png" }] },
        },
      }),
    )
    const result = t.ingestKeepingFiles(deleteFrom(1000))
    expect(result.done).toEqual(["delete"])
    expect([...result.removeFiles].sort()).toEqual([current, earlier].sort())
    expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([])
    expect([current, earlier].map(existsSync)).toEqual([true, true])
    removeFiles(result.removeFiles)
    expect([current, earlier].map(existsSync)).toEqual([false, false])
  })

  test("stay when the transaction rolls back, with their rows", () => {
    const file = attachmentFile("keep.png")
    t.ingest(dataFrom(ALICE, 1000, { message: "mine", attachments: [{ id: "keep.png" }] }))
    const failure = new Error("stop")
    expect(() =>
      inTransaction(t.mirror, () => {
        const result = ingestEnvelope(t.mirror, deleteFrom(1000), t.ctx())
        expect(result.removeFiles).toEqual([file])
        throw failure
      }),
    ).toThrow(failure)
    expect(columnOf(t.mirror, "SELECT body FROM messages")).toEqual(["mine"])
    expect(existsSync(file)).toBe(true)
  })

  test("come from a delete made on another device too", () => {
    const file = attachmentFile("mine.png")
    t.ingest(sentTo(ALICE, 1000, { message: "sent", attachments: [{ id: "mine.png" }] }))
    const result = t.ingestKeepingFiles(
      syncFromMe({ sentMessage: { destinationUuid: ALICE, timestamp: 1001, remoteDelete: { timestamp: 1000 } } }),
    )
    expect(result).toEqual({ done: ["delete"], removeFiles: [file] })
  })

  test("are only those whose id is a plain file name inside the attachments directory", () => {
    t.ingest(
      dataFrom(ALICE, 1000, {
        message: "files",
        attachments: [
          { id: "../outside.txt" },
          { id: ".hidden" },
          { id: "sub/x" },
          { id: "" },
          { id: "ok.png" },
          { type: "x" },
        ],
      }),
    )
    expect(t.ingestKeepingFiles(deleteFrom(1000)).removeFiles).toEqual([join(t.attachmentsDir, "ok.png")])
  })

  test("are not listed when there is no message to delete", () => {
    expect(t.ingestKeepingFiles(deleteFrom(1000))).toEqual({ done: ["delete-early"], removeFiles: [] })
  })
})

describe("removeFiles", () => {
  test("removes the files, and neither a missing file nor one that cannot be removed stops it", () => {
    const first = attachmentFile("first.png")
    const second = attachmentFile("second.png")
    const folder = join(t.attachmentsDir, "folder")
    mkdirSync(folder)
    const outside = join(dirname(t.attachmentsDir), "outside.txt")
    writeFileSync(outside, "data")
    expect(() => removeFiles([first, join(t.attachmentsDir, "missing.png"), folder, second])).not.toThrow()
    expect([first, second].map(existsSync)).toEqual([false, false])
    expect([folder, outside].map(existsSync)).toEqual([true, true])
    expect(() => removeFiles([])).not.toThrow()
  })
})
