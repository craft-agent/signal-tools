import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { upsertContacts } from "./directory"
import { getMeta } from "./mirror"
import {
  ALICE,
  BOB,
  GROUP_ID,
  ME,
  NOW,
  NUMBER,
  columnOf,
  createTestMirror,
  dataFrom,
  messageRow,
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

describe("sent transcripts", () => {
  test("a message sent from another device to a person is the account's own, in that person's chat", () => {
    expect(t.ingest(sentTo(ALICE, 1000, { message: "from the phone", destinationNumber: NUMBER }))).toEqual([
      ["message"],
    ])
    expect(messageRow(t.mirror, ME, 1000)).toMatchObject({
      chat: ALICE,
      from_me: 1,
      author_name: null,
      body: "from the phone",
      expire_start: null,
    })
    expect(rowsOf(t.mirror, "SELECT id, kind, number, last_ts FROM chats")).toEqual([
      { id: ALICE, kind: "person", number: NUMBER, last_ts: 1000 },
    ])
  })

  test("a destination known only by number is found through the contacts", () => {
    upsertContacts(t.mirror, [{ uuid: BOB, number: NUMBER }], NOW)
    t.ingest(syncFromMe({ sentMessage: { destinationNumber: NUMBER, timestamp: 1000, message: "hi" } }))
    expect(messageRow(t.mirror, ME, 1000)).toMatchObject({ chat: BOB })
  })

  test("a destination that cannot be found is reported and stores nothing", () => {
    const payload = syncFromMe({ sentMessage: { destinationNumber: NUMBER, timestamp: 1000, message: "hi" } })
    expect(t.ingest(payload)).toEqual([["sent-unknown-chat"]])
    expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([])
  })

  test("a message sent to a group lands in the group", () => {
    t.ingest(syncFromMe({ sentMessage: { timestamp: 1000, message: "hello all", groupInfo: { groupId: GROUP_ID } } }))
    expect(messageRow(t.mirror, ME, 1000)).toMatchObject({ chat: `group:${GROUP_ID}`, from_me: 1 })
    expect(rowsOf(t.mirror, "SELECT id, kind, number FROM chats")).toEqual([
      { id: `group:${GROUP_ID}`, kind: "group", number: null },
    ])
  })

  test("a message to oneself is a message in the account's own chat", () => {
    t.ingest(sentTo(ME, 1000, { message: "note to self" }))
    expect(messageRow(t.mirror, ME, 1000)).toMatchObject({ chat: ME, from_me: 1, body: "note to self" })
  })

  test("a disappearing message sent from another device starts its timer when it was sent", () => {
    t.ingest(sentTo(ALICE, 1000, { message: "brief", expiresInSeconds: 60 }))
    expect(messageRow(t.mirror, ME, 1000)).toMatchObject({ expires_in: 60, expire_start: 1000 })
  })

  test("a timer change, a reaction and a delete made on another device apply as the account's own", () => {
    t.ingest(
      sentTo(ALICE, 1000, { message: "oops" }),
      sentTo(ALICE, 1001, { isExpirationUpdate: true, expiresInSeconds: 600 }),
      dataFrom(ALICE, 1002, { message: "hi" }),
      sentTo(ALICE, 1003, { reaction: { emoji: "👍", targetAuthorUuid: ALICE, targetSentTimestamp: 1002 } }),
    )
    expect(rowsOf(t.mirror, "SELECT expires_in FROM chats")).toEqual([{ expires_in: 600 }])
    expect(rowsOf(t.mirror, "SELECT reactor, emoji FROM reactions")).toEqual([{ reactor: ME, emoji: "👍" }])
    expect(t.ingest(sentTo(ALICE, 1004, { remoteDelete: { timestamp: 1000 } }))).toEqual([["delete"]])
    expect(messageRow(t.mirror, ME, 1000)).toBeUndefined()
  })

  test("a sent edit keeps the earlier version, in a person's chat and in a group", () => {
    const edit = (destination: Record<string, unknown>, target: number, edited: number) =>
      syncFromMe({
        sentMessage: {
          ...destination,
          timestamp: edited,
          editMessage: {
            targetSentTimestamp: target,
            dataMessage: { timestamp: edited, message: `edited ${edited}`, ...destination },
          },
        },
      })
    const group = { groupInfo: { groupId: GROUP_ID } }
    t.ingest(
      sentTo(ALICE, 1000, { message: "person" }),
      syncFromMe({ sentMessage: { timestamp: 2000, message: "group", ...group } }),
      edit({ destinationUuid: ALICE }, 1000, 1100),
      edit(group, 2000, 2100),
    )
    expect(messageRow(t.mirror, ME, 1000)).toMatchObject({ chat: ALICE, body: "edited 1100", edited: 1100 })
    expect(messageRow(t.mirror, ME, 2000)).toMatchObject({ chat: `group:${GROUP_ID}`, body: "edited 2100" })
    expect(rowsOf(t.mirror, "SELECT ts, rev_ts, body FROM edits ORDER BY ts")).toEqual([
      { ts: 1000, rev_ts: 1000, body: "person" },
      { ts: 2000, rev_ts: 2000, body: "group" },
    ])
  })

  test("an edit that cannot be read is reported as skipped", () => {
    expect(t.ingest(sentTo(ALICE, 1000, { editMessage: { targetSentTimestamp: "x" } }))).toEqual([["edit-skipped"]])
  })
})

describe("read syncs", () => {
  test("starts the timer of a received disappearing message at the time of the read", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "brief", expiresInSeconds: 60 }))
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ read_at: null, expire_start: null })
    const read = syncFromMe({ readMessages: [{ senderUuid: ALICE, timestamp: 1000 }] })
    expect(t.ingestAt(NOW + 5000, read)).toEqual(["read"])
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ read_at: NOW + 5000, expire_start: NOW + 5000 })
    t.ingestAt(NOW + 9000, read)
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ read_at: NOW + 5000, expire_start: NOW + 5000 })
  })

  test("marks a message without a timer read and starts nothing", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "plain" }))
    t.ingestAt(NOW + 5000, syncFromMe({ readMessages: [{ senderUuid: ALICE, timestamp: 1000 }] }))
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ read_at: NOW + 5000, expire_start: null })
  })

  test("finds the sender by number", () => {
    upsertContacts(t.mirror, [{ uuid: ALICE, number: NUMBER }], NOW)
    t.ingest(dataFrom(ALICE, 1000, { message: "brief", expiresInSeconds: 60 }))
    t.ingestAt(
      NOW + 1,
      syncFromMe({
        readMessages: [
          { senderNumber: NUMBER, timestamp: 1000 },
          { senderNumber: "+0", timestamp: 1 },
        ],
      }),
    )
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ read_at: NOW + 1, expire_start: NOW + 1 })
  })

  test("leaves a read of a message the mirror lacks, and a malformed one, harmless", () => {
    const reads = [{ senderUuid: ALICE, timestamp: 5 }, "x", { senderUuid: ALICE }]
    expect(t.ingest(syncFromMe({ readMessages: reads }))).toEqual([["read"]])
    expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([])
  })
})

describe("directory syncs", () => {
  test("a contacts or groups sync marks the groups stale", () => {
    expect(t.ingest(syncFromMe({ type: "CONTACTS_SYNC" }))).toEqual([["contacts-sync"]])
    expect(getMeta(t.mirror)).toEqual({ groups_stale: "1" })
  })

  test("a groups sync does too, and other sync types do nothing", () => {
    expect(t.ingest(syncFromMe({ type: "OTHER" }))).toEqual([["ignored"]])
    expect(getMeta(t.mirror)).toEqual({})
    expect(t.ingest(syncFromMe({ type: "GROUPS_SYNC" }))).toEqual([["groups-sync"]])
    expect(getMeta(t.mirror)).toEqual({ groups_stale: "1" })
  })
})
