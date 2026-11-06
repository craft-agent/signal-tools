import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ALICE,
  BOB,
  ME,
  columnOf,
  createTestMirror,
  dataFrom,
  deleteFrom,
  editFrom,
  reactionFrom,
  rowsOf,
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

function deletedTimes(): unknown[] {
  return columnOf(t.mirror, "SELECT ts FROM deleted ORDER BY ts")
}

function nothingStored(): void {
  expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([])
  expect(columnOf(t.mirror, "SELECT ts FROM edits")).toEqual([])
  expect(columnOf(t.mirror, "SELECT ts FROM reactions")).toEqual([])
}

describe("a delete for everyone that arrives first", () => {
  test("is recorded, and the message that follows is dropped without a trace", () => {
    expect(t.ingest(deleteFrom(ALICE, 1000))).toEqual([["delete-early"]])
    expect(rowsOf(t.mirror, "SELECT author, ts, at FROM deleted")).toEqual([
      { author: ALICE, ts: 1000, at: 1_800_000_000_000 },
    ])
    expect(t.ingest(dataFrom(ALICE, 1000, { message: "late" }))).toEqual([["dropped-deleted"]])
    nothingStored()
    expect(columnOf(t.mirror, "SELECT id FROM chats")).toEqual([])
  })

  test("belongs to its author: another sender's message at the same time is kept", () => {
    t.ingest(deleteFrom(ALICE, 1000), dataFrom(BOB, 1000, { message: "mine" }))
    expect(columnOf(t.mirror, "SELECT body FROM messages")).toEqual(["mine"])
  })

  test("drops a sent transcript of the account's own deleted message, too", () => {
    const deleteSent = syncFromMe({
      sentMessage: { destinationUuid: ALICE, timestamp: 1001, remoteDelete: { timestamp: 1000 } },
    })
    expect(t.ingest(deleteSent, sentTo(ALICE, 1000, { message: "late" }))).toEqual([
      ["delete-early"],
      ["dropped-deleted"],
    ])
    expect(deletedTimes()).toEqual([1000])
    nothingStored()
  })

  test("drops a late edit and records its revision too, so the original that follows is dropped", () => {
    t.ingest(deleteFrom(ALICE, 1100))
    expect(t.ingest(editFrom(ALICE, 1000, 1100, { message: "v2" }))).toEqual([["dropped-deleted"]])
    expect(deletedTimes()).toEqual([1000, 1100])
    expect(t.ingest(dataFrom(ALICE, 1000, { message: "v1" }))).toEqual([["dropped-deleted"]])
    nothingStored()
  })

  test("drops a late edit of a message that was deleted by its original time", () => {
    t.ingest(deleteFrom(ALICE, 1000))
    expect(
      t.ingest(editFrom(ALICE, 1000, 1100, { message: "v2" }), editFrom(ALICE, 1100, 1200, { message: "v3" })),
    ).toEqual([["dropped-deleted"], ["dropped-deleted"]])
    expect(deletedTimes()).toEqual([1000, 1100, 1200])
    nothingStored()
  })

  test("drops a late reaction, added or removed", () => {
    t.ingest(deleteFrom(ALICE, 1000))
    expect(t.ingest(reactionFrom(BOB, 1000, ALICE, "👍"), reactionFrom(BOB, 1000, ALICE, "👍", true))).toEqual([
      ["dropped-deleted"],
      ["dropped-deleted"],
    ])
    nothingStored()
  })

  test("removes what had already arrived for it: reactions and quotes", () => {
    t.ingest(
      reactionFrom(BOB, 1000, ALICE, "👍"),
      dataFrom(BOB, 2000, { message: "re", quote: { id: 1000, authorUuid: ALICE, text: "q" } }),
    )
    expect(columnOf(t.mirror, "SELECT emoji FROM reactions")).toEqual(["👍"])
    t.ingest(deleteFrom(ALICE, 1000))
    expect(columnOf(t.mirror, "SELECT emoji FROM reactions")).toEqual([])
    expect(columnOf(t.mirror, "SELECT quote FROM messages")).toEqual([null])
  })
})

describe("a delete that finds the message", () => {
  test("records the original, every revision and the time it was given", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "v1" }),
      editFrom(ALICE, 1000, 1100, { message: "v2" }),
      editFrom(ALICE, 1000, 1200, { message: "v3" }),
    )
    expect(t.ingest(deleteFrom(ALICE, 1100))).toEqual([["delete"]])
    expect(deletedTimes()).toEqual([1000, 1100, 1200])
    nothingStored()
  })

  test("drops the redelivery of the original, of each edit, and of a reaction to it", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "v1" }),
      editFrom(ALICE, 1000, 1100, { message: "v2" }),
      deleteFrom(ALICE, 1100),
    )
    const late = [
      dataFrom(ALICE, 1000, { message: "v1" }),
      editFrom(ALICE, 1000, 1100, { message: "v2" }),
      editFrom(ALICE, 1000, 1150, { message: "v2.5" }),
      reactionFrom(ME, 1000, ALICE, "👍"),
    ]
    expect(t.ingest(...late)).toEqual([
      ["dropped-deleted"],
      ["dropped-deleted"],
      ["dropped-deleted"],
      ["dropped-deleted"],
    ])
    expect(deletedTimes()).toEqual([1000, 1100, 1150])
    nothingStored()
  })

  test("a repeated delete changes nothing", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "v1" }), deleteFrom(ALICE, 1000))
    expect(t.ingest(deleteFrom(ALICE, 1000))).toEqual([["delete-early"]])
    expect(deletedTimes()).toEqual([1000])
  })

  test("keeps no content: the record is the author, the time and when it was recorded", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "secret", attachments: [{ id: "a.png" }] }), deleteFrom(ALICE, 1000))
    expect(rowsOf(t.mirror, "SELECT * FROM deleted")).toEqual([{ author: ALICE, ts: 1000, at: 1_800_000_000_000 }])
  })
})
