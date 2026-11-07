import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ALICE,
  ME,
  columnOf,
  createTestMirror,
  dataFrom,
  deleteFrom,
  editFrom,
  reactionFrom,
  sentTo,
  type TestMirror,
} from "./mirror.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => {
  t.close()
})

/** The timers of every chat in the mirror. */
function chatTimers(): unknown[] {
  return columnOf(t.mirror, "SELECT expires_in FROM chats")
}

describe("a chat's timer from its ordinary messages", () => {
  test("an incoming message sets it", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "hi", expiresInSeconds: 3600 }))
    expect(chatTimers()).toEqual([3600])
  })

  test("a later message with none clears it", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "hi", expiresInSeconds: 3600 }),
      dataFrom(ALICE, 2000, { message: "bye", expiresInSeconds: 0 }),
    )
    expect(chatTimers()).toEqual([0])
  })

  test("a later message that does not carry a timer leaves it", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "hi", expiresInSeconds: 3600 }),
      dataFrom(ALICE, 2000, { message: "more" }),
    )
    expect(chatTimers()).toEqual([3600])
  })

  test("an older message ingested after a newer one leaves the newer timer", () => {
    t.ingest(
      dataFrom(ALICE, 2000, { message: "new", expiresInSeconds: 600 }),
      dataFrom(ALICE, 1000, { message: "old", expiresInSeconds: 3600 }),
    )
    expect(chatTimers()).toEqual([600])
  })

  test("a message sent from another device sets it", () => {
    t.ingest(sentTo(ALICE, 1000, { message: "from the phone", expiresInSeconds: 604800 }))
    expect(chatTimers()).toEqual([604800])
  })

  test("a message to oneself sets the timer of the Note to Self", () => {
    t.ingest(sentTo(ME, 1000, { message: "note", expiresInSeconds: 604800 }))
    expect(columnOf(t.mirror, "SELECT expires_in FROM chats WHERE id = ?", ME)).toEqual([604800])
  })

  test("a timer update still sets it", () => {
    t.ingest(dataFrom(ALICE, 1000, { isExpirationUpdate: true, expiresInSeconds: 60 }))
    expect(chatTimers()).toEqual([60])
  })

  test("an edit does not set it, whether or not the original was seen", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "hi", expiresInSeconds: 3600 }),
      editFrom(ALICE, 1000, 1100, { message: "hi!", expiresInSeconds: 60 }),
      editFrom(ALICE, 500, 1200, { message: "unseen", expiresInSeconds: 30 }),
    )
    expect(chatTimers()).toEqual([3600])
    t.close()
    t = createTestMirror()
    t.ingest(editFrom(ALICE, 500, 1200, { message: "unseen", expiresInSeconds: 30 }))
    expect(chatTimers()).toEqual([null])
  })

  test("a reaction and a delete do not set it", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "hi", expiresInSeconds: 3600 }),
      reactionFrom(ALICE, 1000, ALICE, "👍"),
      deleteFrom(ALICE, 1000),
    )
    expect(chatTimers()).toEqual([3600])
    t.ingest(
      dataFrom(ALICE, 5000, {
        reaction: { emoji: "👍", targetAuthorUuid: ALICE, targetSentTimestamp: 1, isRemove: false },
        expiresInSeconds: 0,
      }),
      dataFrom(ALICE, 6000, { remoteDelete: { timestamp: 2 }, expiresInSeconds: 0 }),
    )
    expect(chatTimers()).toEqual([3600])
  })
})
