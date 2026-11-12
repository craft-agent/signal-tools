import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { accepted, SENT } from "../../message/send.testing"
import { messageId } from "../../signal/ids"
import { ALICE, ME, dataFrom, messageRow, rowsOf, sentTo } from "../../signal/mirror.testing"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"

const NOT_RECORDED = "the message was sent but is not in the mirror yet"

let t: FileSendFixture

beforeEach(async () => {
  t = createFileSendFixture()
  await t.serve(accepted(ALICE))
})

afterEach(async () => {
  await t.close()
})

/** The stored message at `ts` without what differs between two copies of one message: its time and when it was received. */
function stored(ts: number): Record<string, unknown> {
  const { ts: _ts, received: _received, ...row } = messageRow(t.mirror, ME, ts)!
  return row
}

describe("a send that Signal accepted", () => {
  test("is in the mirror as the user's own message with its files, and a chat read shows them", async () => {
    await t.sendFiles({ chat: ALICE, files: [{ path: t.write("notes.txt", "hello\n") }], text: "here" })
    expect(messageRow(t.mirror, ME, SENT)).toMatchObject({ chat: ALICE, from_me: 1, body: "here", kind: "message" })
    const message = (await t.messages(ALICE)).find((entry) => entry.id === messageId(ME, SENT))
    expect(message).toMatchObject({
      from: "me",
      text: "here",
      files: [{ name: "notes.txt", type: "text/plain", size: 6 }],
    })
  })

  test("is stored exactly as a sent transcript of the same files from another device is", async () => {
    await t.sendFiles({
      chat: ALICE,
      files: [{ path: t.write("notes.txt", "hello\n") }, { path: t.write("photo.png", "png bytes") }],
      text: "here",
    })
    t.ingest(
      sentTo(ALICE, SENT + 1, {
        message: "here",
        attachments: [
          { contentType: "text/plain", filename: "notes.txt", size: 6 },
          { contentType: "image/png", filename: "photo.png", size: 9 },
        ],
      }),
    )
    expect(stored(SENT)).toEqual(stored(SENT + 1))
    expect(JSON.parse(String(stored(SENT).attachments))).toEqual([
      { type: "text/plain", name: "notes.txt", size: 6 },
      { type: "image/png", name: "photo.png", size: 9 },
    ])
  })

  test("without a caption it is stored as files only, as a transcript of files only is", async () => {
    await t.sendFiles({ chat: ALICE, files: [{ path: t.write("data.bin", "bytes") }] })
    t.ingest(
      sentTo(ALICE, SENT + 1, {
        attachments: [{ contentType: "application/octet-stream", filename: "data.bin", size: 5 }],
      }),
    )
    expect(stored(SENT)).toMatchObject({ body: null })
    expect(stored(SENT)).toEqual(stored(SENT + 1))
    const message = (await t.messages(ALICE)).find((entry) => entry.id === messageId(ME, SENT))
    expect(message).not.toHaveProperty("text")
    expect(message).toMatchObject({ files: [{ name: "data.bin", type: "application/octet-stream", size: 5 }] })
  })

  test("a reply keeps its quote with the files", async () => {
    await t.sendFiles({ chat: ALICE, files: [{ path: t.write("a.txt") }], reply_to: messageId(ALICE, 5000) })
    t.ingest(
      sentTo(ALICE, SENT + 1, {
        attachments: [{ contentType: "text/plain", filename: "a.txt", size: 16 }],
        quote: { id: 5000, authorUuid: ALICE, text: "hello from Alice" },
      }),
    )
    expect(stored(SENT)).toEqual(stored(SENT + 1))
  })

  test("a reply to a file-only message keeps its quoted file with the sent files", async () => {
    t.ingest(dataFrom(ALICE, 5100, { attachments: [{ contentType: "image/png", filename: "a.png" }] }))
    await t.sendFiles({ chat: ALICE, files: [{ path: t.write("a.txt") }], reply_to: messageId(ALICE, 5100) })
    expect(JSON.parse(String(stored(SENT).quote))).toEqual({
      id: 5100,
      author: ALICE,
      text: null,
      attachments: [{ type: "image/png", name: "a.png" }],
    })
  })

  test("takes the timer from the chat's latest ordinary message, started at the sent time", async () => {
    t.ingest(dataFrom(ALICE, 5200, { message: "earlier", expiresInSeconds: 3600 }))
    await t.sendFiles({ chat: ALICE, files: [{ path: t.write("a.txt") }] })
    expect(stored(SENT)).toMatchObject({ expires_in: 3600, expire_start: SENT })
  })

  test("the file's name is the one it was sent under, whatever link it was named by", async () => {
    const path = t.write("real-name.txt")
    symlinkSync(path, join(t.work, "alias.txt"))
    await t.sendFiles({ chat: ALICE, files: [{ path: "alias.txt" }] })
    expect(JSON.parse(String(stored(SENT).attachments))).toMatchObject([{ name: "real-name.txt" }])
  })
})

describe("a record that cannot be made", () => {
  test("is reported under errors.record while the result says the files went out", async () => {
    t.mirror.exec("CREATE TRIGGER stop BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'boom'); END")
    const result = await t.sendFiles({ chat: ALICE, files: [{ path: t.write("a.txt", "x") }] })
    expect(result).toMatchObject({ id: messageId(ME, SENT), chat: ALICE, files: [{ name: "a.txt", size: 1 }] })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(result.errors?.record).not.toContain("boom")
    expect(messageRow(t.mirror, ME, SENT)).toBeUndefined()
    expect(t.outboxEntries()).toEqual([])
  })

  test("a mirror that cannot be written is reported without the driver's words", async () => {
    await t.serve(() => {
      for (const suffix of ["", "-wal", "-shm"]) chmodSync(`${t.paths.mirror}${suffix}`, 0o400)
      return accepted(ALICE)
    })
    try {
      const result = await t.sendFiles({ chat: ALICE, files: [{ path: t.write("a.txt") }] })
      expect(result.errors?.record).toContain(NOT_RECORDED)
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) chmodSync(`${t.paths.mirror}${suffix}`, 0o600)
    }
  })
})

describe("a send that failed", () => {
  test("is not recorded", async () => {
    await t.serve("close")
    await t.filesFailure({ chat: ALICE, files: [{ path: t.write("a.txt") }] })
    expect(rowsOf(t.mirror, "SELECT 1 FROM messages WHERE author = ? AND ts = ?", ME, SENT)).toEqual([])
  })
})
