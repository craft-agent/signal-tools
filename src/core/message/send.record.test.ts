import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, rmSync } from "node:fs"
import { GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, ME, dataFrom, messageRow, rowsOf, sentTo } from "../signal/mirror.testing"
import { accepted, createSendFixture, SENT, type SendFixture } from "./send.testing"

const NOT_RECORDED = "the message was sent but is not in the mirror yet"

let t: SendFixture

beforeEach(async () => {
  t = createSendFixture()
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
  test("is in the mirror as the user's own message, and a chat read shows it", async () => {
    const before = Date.now()
    const result = await t.send({ chat: ALICE, text: "hello" })
    expect(result.errors).toBeUndefined()
    expect(messageRow(t.mirror, ME, SENT)).toMatchObject({
      chat: ALICE,
      from_me: 1,
      body: "hello",
      kind: "message",
      expires_in: 0,
      expire_start: null,
    })
    expect(Number(messageRow(t.mirror, ME, SENT)!.received)).toBeGreaterThanOrEqual(before)
    const messages = await t.messages(ALICE)
    expect(messages.at(-1)).toMatchObject({ id: messageId(ME, SENT), from: "me", text: "hello" })
    expect(messages.at(-1)).not.toHaveProperty("from_id")
    expect(rowsOf(t.mirror, "SELECT last_ts FROM chats WHERE id = ?", ALICE)).toEqual([{ last_ts: SENT }])
  })

  test("is stored exactly as a sent transcript of the same message from another device is", async () => {
    await t.send({ chat: ALICE, text: "hello" })
    t.ingest(sentTo(ALICE, SENT + 1, { message: "hello" }))
    expect(stored(SENT)).toEqual(stored(SENT + 1))
  })

  test("a reply keeps its quote as a transcript's quote is stored, and a read shows it", async () => {
    await t.send({ chat: ALICE, text: "got it", reply_to: messageId(ALICE, 5000) })
    t.ingest(
      sentTo(ALICE, SENT + 1, {
        message: "got it",
        quote: { id: 5000, authorUuid: ALICE, text: "hello from Alice" },
      }),
    )
    expect(stored(SENT)).toEqual(stored(SENT + 1))
    expect(JSON.parse(String(stored(SENT).quote))).toEqual({ id: 5000, author: ALICE, text: "hello from Alice" })
    const messages = await t.messages(ALICE)
    expect(messages.find((message) => message.id === messageId(ME, SENT))).toMatchObject({
      from: "me",
      reply_to: { id: messageId(ALICE, 5000), text: "hello from Alice" },
    })
  })

  test("a reply to a file-only message keeps its quoted file as a transcript does", async () => {
    t.ingest(dataFrom(ALICE, 5100, { attachments: [{ contentType: "image/png", filename: "a.png" }] }))
    await t.send({ chat: ALICE, text: "got it", reply_to: messageId(ALICE, 5100) })
    t.ingest(
      sentTo(ALICE, SENT + 1, {
        message: "got it",
        quote: { id: 5100, authorUuid: ALICE, attachments: [{ contentType: "image/png", filename: "a.png" }] },
      }),
    )
    expect(stored(SENT)).toEqual(stored(SENT + 1))
    expect(JSON.parse(String(stored(SENT).quote))).toEqual({
      id: 5100,
      author: ALICE,
      text: null,
      attachments: [{ type: "image/png", name: "a.png" }],
    })
    const messages = await t.messages(ALICE)
    expect(messages.find((message) => message.id === messageId(ME, SENT))?.reply_to).toEqual({
      id: messageId(ALICE, 5100),
      text: null,
    })
  })

  test("takes the chat's disappearing timer, started at the sent time, as a transcript does", async () => {
    t.ingest(sentTo(ALICE, 5200, { isExpirationUpdate: true, expiresInSeconds: 3600 }))
    await t.send({ chat: ALICE, text: "hello" })
    t.ingest(sentTo(ALICE, SENT + 1, { message: "hello", expiresInSeconds: 3600 }))
    expect(stored(SENT)).toMatchObject({ expires_in: 3600, expire_start: SENT })
    expect(stored(SENT)).toEqual({ ...stored(SENT + 1), expire_start: SENT })
    expect((await t.messages(ALICE)).find((message) => message.id === messageId(ME, SENT))).toMatchObject({
      disappears_after_seconds: 3600,
    })
  })

  test("takes the timer from the chat's latest ordinary message when no timer update was seen", async () => {
    t.ingest(dataFrom(ALICE, 5200, { message: "earlier", expiresInSeconds: 3600 }))
    await t.send({ chat: ALICE, text: "hello" })
    expect(stored(SENT)).toMatchObject({ expires_in: 3600, expire_start: SENT })
  })

  test("a timer a later message cleared is not taken", async () => {
    t.ingest(
      dataFrom(ALICE, 5200, { message: "earlier", expiresInSeconds: 3600 }),
      dataFrom(ALICE, 5300, { message: "later", expiresInSeconds: 0 }),
    )
    await t.send({ chat: ALICE, text: "hello" })
    expect(stored(SENT)).toMatchObject({ expires_in: 0, expire_start: null })
  })

  test("a group's message is recorded in the group", async () => {
    await t.send({ chat: GROUP, text: "team" })
    expect(messageRow(t.mirror, ME, SENT)).toMatchObject({ chat: GROUP, body: "team", from_me: 1 })
    expect(rowsOf(t.mirror, "SELECT last_ts FROM chats WHERE id = ?", GROUP)).toEqual([{ last_ts: SENT }])
  })

  test("a Note to Self is recorded in the user's own chat", async () => {
    await t.serve({ result: { timestamp: SENT } })
    await t.send({ chat: ME, text: "remember" })
    expect(messageRow(t.mirror, ME, SENT)).toMatchObject({ chat: ME, body: "remember", from_me: 1 })
  })

  test("is recorded once when the same time comes back", async () => {
    await t.send({ chat: ALICE, text: "hello" })
    await t.send({ chat: ALICE, text: "hello" })
    expect(rowsOf(t.mirror, "SELECT 1 FROM messages WHERE author = ? AND ts = ?", ME, SENT)).toHaveLength(1)
  })
})

describe("a message the sync service also stores", () => {
  const transcript = (extra: Record<string, unknown> = {}) =>
    sentTo(ALICE, SENT, {
      message: "got it",
      quote: { id: 5000, authorUuid: ALICE, text: "hello from Alice" },
      ...extra,
    })
  const rows = () => rowsOf(t.mirror, "SELECT * FROM messages WHERE author = ? AND ts = ?", ME, SENT)

  test("its transcript arriving after the record leaves the one row as it was", async () => {
    await t.send({ chat: ALICE, text: "got it", reply_to: messageId(ALICE, 5000) })
    const recorded = rows()
    expect(recorded).toHaveLength(1)
    t.ingestAt(Date.now() + 1000, transcript({ message: "got it, changed" }))
    expect(rows()).toEqual(recorded)
    expect(recorded[0]).toMatchObject({ body: "got it" })
  })

  test("its transcript arriving first does not fail the record, and one row stays", async () => {
    t.ingest(transcript())
    const first = rows()
    const result = await t.send({ chat: ALICE, text: "got it", reply_to: messageId(ALICE, 5000) })
    expect(result.errors).toBeUndefined()
    expect(rows()).toEqual(first)
  })
})

describe("a record that fails midway", () => {
  const snapshot = () => ({
    messages: rowsOf(t.mirror, "SELECT * FROM messages ORDER BY author, ts"),
    chats: rowsOf(t.mirror, "SELECT * FROM chats ORDER BY id"),
  })

  test.each([
    ["the chat's update", "BEFORE UPDATE ON chats"],
    ["the message's insert, after the chat was touched", "BEFORE INSERT ON messages"],
  ])("fails at %s and the whole record rolls back", async (_name, when) => {
    t.mirror.exec(`CREATE TRIGGER stop ${when} BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const before = snapshot()
    const result = await t.send({ chat: ALICE, text: "hello" })
    expect(result).toMatchObject({ id: messageId(ME, SENT), chat: ALICE })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(result.errors?.record).not.toContain("boom")
    expect(snapshot()).toEqual(before)
  })
})

describe("a record that fails", () => {
  const messageCount = () => rowsOf(t.mirror, "SELECT COUNT(*) AS n FROM messages")[0]!.n

  /** Answers the send as accepted after `spoil` has changed the mirror, as when it is damaged while the send is under way. */
  async function serveAfter(spoil: () => void): Promise<void> {
    await t.serve(() => {
      spoil()
      return accepted(ALICE)
    })
  }

  test("a mirror of another version is left alone, and the result says the message went out", async () => {
    await serveAfter(() => t.mirror.exec("PRAGMA user_version = 99"))
    const before = messageCount()
    const result = await t.send({ chat: ALICE, text: "hello" })
    expect(result).toMatchObject({ id: messageId(ME, SENT), chat: ALICE })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(result.errors?.record).toContain("newer version")
    expect(messageCount()).toBe(before)
    expect(rowsOf(t.mirror, "PRAGMA user_version")).toEqual([{ user_version: 99 }])
  })

  test("an older mirror is not migrated", async () => {
    await serveAfter(() => t.mirror.exec("DROP INDEX messages_ts; PRAGMA user_version = 1"))
    const result = await t.send({ chat: ALICE, text: "hello" })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(rowsOf(t.mirror, "PRAGMA user_version")).toEqual([{ user_version: 1 }])
    expect(rowsOf(t.mirror, "SELECT name FROM sqlite_master WHERE name = 'messages_ts'")).toEqual([])
  })

  test("a mirror that has gone missing is reported, and no file is created", async () => {
    await serveAfter(() => rmSync(t.paths.mirror))
    const result = await t.send({ chat: ALICE, text: "hello" })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(existsSync(t.paths.mirror)).toBe(false)
  })

  test("a mirror that cannot be written is reported without the driver's words", async () => {
    await serveAfter(() => {
      for (const suffix of ["", "-wal", "-shm"]) chmodSync(`${t.paths.mirror}${suffix}`, 0o400)
    })
    try {
      const result = await t.send({ chat: ALICE, text: "hello" })
      expect(result).toMatchObject({ id: messageId(ME, SENT) })
      expect(result.errors?.record).toContain(NOT_RECORDED)
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) chmodSync(`${t.paths.mirror}${suffix}`, 0o600)
    }
    expect(messageRow(t.mirror, ME, SENT)).toBeUndefined()
  })
})
