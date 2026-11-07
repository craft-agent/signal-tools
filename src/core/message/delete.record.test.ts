import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { messageId } from "../signal/ids"
import { ALICE, dataFrom, deleteFrom, ME, reactionFrom, rowsOf, sentTo } from "../signal/mirror.testing"
import { AT, createActionFixture, OWN, type ActionFixture } from "./action.testing"
import { accepted } from "./send.testing"

const STILL_THERE = "the message was deleted for everyone but is still in the mirror"
const ID = messageId(ME, OWN)

let t: ActionFixture

beforeEach(async () => {
  t = createActionFixture()
  setSystemTime(new Date(AT))
  await t.serve(accepted(ALICE))
  t.ownMessage(OWN, { message: "first" })
})

afterEach(async () => {
  setSystemTime()
  await t.close()
})

const count = (sql: string, ...params: number[]) => Number(rowsOf(t.mirror, sql, ...params)[0]!.n)

/** Writes a file where signal-cli keeps received files, and returns its path. */
function storedFile(name: string): string {
  mkdirSync(t.paths.attachments, { recursive: true })
  const path = join(t.paths.attachments, name)
  writeFileSync(path, "data")
  return path
}

/** Gives the message at `base` an edit, a reaction and a reply of Alice's that quotes it, as a message with a history has. */
function giveHistory(base: number): void {
  t.ingest(
    dataFrom(ALICE, base + 500, { message: "re", quote: { id: base, authorUuid: ME, text: "first" } }),
    reactionFrom(ALICE, base, ME, "👍"),
  )
  t.ownEdit(base, base + 100, "edited")
}

/** What is left of the message at `base`, with times as distances from it, so two messages can be compared. */
function traces(base: number) {
  return {
    messages: count("SELECT COUNT(*) AS n FROM messages WHERE ts = ?", base),
    versions: count("SELECT COUNT(*) AS n FROM edits WHERE ts = ?", base),
    reactions: count("SELECT COUNT(*) AS n FROM reactions WHERE ts = ?", base),
    deleted: rowsOf(
      t.mirror,
      "SELECT ts - ? AS at FROM deleted WHERE ts >= ? AND ts < ? ORDER BY ts",
      base,
      base,
      base + 400,
    ),
    quotes: rowsOf(t.mirror, "SELECT quote FROM messages WHERE ts = ?", base + 500),
  }
}

const snapshot = () => ({
  messages: rowsOf(t.mirror, "SELECT * FROM messages ORDER BY author, ts"),
  edits: rowsOf(t.mirror, "SELECT * FROM edits ORDER BY author, ts, rev_ts"),
  reactions: rowsOf(t.mirror, "SELECT * FROM reactions ORDER BY author, ts"),
  deleted: rowsOf(t.mirror, "SELECT * FROM deleted ORDER BY author, ts"),
})

describe("a delete that Signal accepted", () => {
  test("takes the message out of a chat read", async () => {
    const before = (await t.messages(ALICE)).map((message) => message.id)
    expect(before).toContain(ID)
    const result = await t.remove({ chat: ALICE, id: ID })
    expect(result.errors).toBeUndefined()
    expect((await t.messages(ALICE)).map((message) => message.id)).toEqual(before.filter((id) => id !== ID))
  })

  test("leaves a tombstone, so that the message arriving again is dropped", async () => {
    await t.remove({ chat: ALICE, id: ID })
    expect(rowsOf(t.mirror, "SELECT author, ts FROM deleted")).toEqual([{ author: ME, ts: OWN }])
    t.ingest(sentTo(ALICE, OWN, { message: "first" }))
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE ts = ?", OWN)).toBe(0)
  })

  test("is stored exactly as the delete of a message from another device is", async () => {
    t.ownMessage(OWN + 1000, { message: "first" })
    giveHistory(OWN)
    giveHistory(OWN + 1000)
    expect(traces(OWN)).toEqual({
      messages: 1,
      versions: 1,
      reactions: 1,
      deleted: [],
      quotes: [{ quote: expect.any(String) }],
    })
    await t.remove({ chat: ALICE, id: ID })
    t.ingest(sentTo(ALICE, OWN + 2000, { remoteDelete: { timestamp: OWN + 1000 } }))
    expect(traces(OWN)).toEqual(traces(OWN + 1000))
    expect(traces(OWN)).toEqual({
      messages: 0,
      versions: 0,
      reactions: 0,
      deleted: [{ at: 0 }, { at: 100 }],
      quotes: [{ quote: null }],
    })
  })

  test("removes the files of the message, and only its own", async () => {
    const own = storedFile("own.png")
    const other = storedFile("other.png")
    t.ownMessage(OWN + 1, { message: "look", attachments: [{ id: "own.png" }] })
    t.ownMessage(OWN + 2, { message: "look too", attachments: [{ id: "other.png" }] })
    await t.remove({ chat: ALICE, id: messageId(ME, OWN + 1) })
    expect(existsSync(own)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  test("a message the sync service already removed is not a failure", async () => {
    await t.serve(() => {
      t.ingest(deleteFrom(ME, OWN))
      return accepted(ALICE)
    })
    const result = await t.remove({ chat: ALICE, id: ID })
    expect(result).toEqual({ id: ID, chat: ALICE, deleted: true })
    expect(rowsOf(t.mirror, "SELECT ts FROM deleted")).toEqual([{ ts: OWN }])
  })
})

describe("a delete that failed or may have", () => {
  test("by an answer lost after the write is uncertain, and the message stays", async () => {
    await t.serve("close")
    const before = snapshot()
    await expect(t.remove({ chat: ALICE, id: ID })).rejects.toMatchObject({ code: "uncertain" })
    expect(snapshot()).toEqual(before)
  })
})

describe("a record that fails", () => {
  test.each([
    ["the message's delete", "BEFORE DELETE ON messages"],
    ["the tombstone, after the rows were deleted", "BEFORE INSERT ON deleted"],
  ])("at %s rolls back, keeps the files and says so under errors", async (_name, when) => {
    giveHistory(OWN)
    const file = storedFile("own.png")
    t.ownMessage(OWN + 1, { message: "look", attachments: [{ id: "own.png" }] })
    t.mirror.exec(`CREATE TRIGGER stop ${when} BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const before = snapshot()
    const result = await t.remove({ chat: ALICE, id: messageId(ME, OWN + 1) })
    expect(result).toMatchObject({ id: messageId(ME, OWN + 1), chat: ALICE, deleted: true })
    expect(result.errors?.record).toContain(STILL_THERE)
    expect(result.errors?.record).not.toContain("boom")
    expect(snapshot()).toEqual(before)
    expect(existsSync(file)).toBe(true)
  })

  test("a mirror of another version is left alone", async () => {
    await t.serve(() => {
      t.mirror.exec("PRAGMA user_version = 99")
      return accepted(ALICE)
    })
    const before = snapshot()
    const result = await t.remove({ chat: ALICE, id: ID })
    expect(result.errors?.record).toContain(STILL_THERE)
    expect(result.errors?.record).toContain("newer version")
    expect(snapshot()).toEqual(before)
  })

  test("a mirror that has gone missing is reported, and no file is created", async () => {
    await t.serve(() => {
      rmSync(t.paths.mirror)
      return accepted(ALICE)
    })
    const result = await t.remove({ chat: ALICE, id: ID })
    expect(result.errors?.record).toContain(STILL_THERE)
    expect(existsSync(t.paths.mirror)).toBe(false)
  })
})
