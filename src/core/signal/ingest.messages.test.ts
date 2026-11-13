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
  envelopeFrom,
  groupDataFrom,
  messageRow,
  rowsOf,
  type TestMirror,
} from "./mirror.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => {
  t.close()
})

describe("incoming messages", () => {
  test("a message from a person lands in that person's chat", () => {
    expect(t.ingest(dataFrom(ALICE, 1000, { message: "hello", expiresInSeconds: 0 }, { sourceName: "Alice" }))).toEqual(
      [["message"]],
    )
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({
      chat: ALICE,
      from_me: 0,
      author_name: "Alice",
      kind: "message",
      body: "hello",
      attachments: null,
      quote: null,
      sticker: 0,
      other: null,
      expires_in: 0,
      expire_start: null,
      view_once: 0,
      edited: null,
      received: NOW,
      mentions: null,
    })
    expect(rowsOf(t.mirror, "SELECT id, kind, last_ts, updated FROM chats")).toEqual([
      { id: ALICE, kind: "person", last_ts: 1000, updated: NOW },
    ])
  })

  test("a message to a group lands in the group's chat, and the chat keeps its latest time", () => {
    t.ingest(groupDataFrom(ALICE, 2000, { message: "later" }), groupDataFrom(BOB, 1500, { message: "earlier" }))
    expect(columnOf(t.mirror, "SELECT chat FROM messages ORDER BY ts")).toEqual([
      `group:${GROUP_ID}`,
      `group:${GROUP_ID}`,
    ])
    expect(rowsOf(t.mirror, "SELECT id, kind, last_ts FROM chats")).toEqual([
      { id: `group:${GROUP_ID}`, kind: "group", last_ts: 2000 },
    ])
  })

  test("the same time from two members of a group is two messages", () => {
    t.ingest(groupDataFrom(ALICE, 3000, { message: "a" }), groupDataFrom(BOB, 3000, { message: "b" }))
    expect(columnOf(t.mirror, "SELECT body FROM messages ORDER BY author")).toEqual(["a", "b"])
  })

  test("delivering the same message twice keeps one", () => {
    const payload = dataFrom(ALICE, 1000, { message: "once" })
    expect(t.ingest(payload, payload)).toEqual([["message"], ["message"]])
    expect(columnOf(t.mirror, "SELECT body FROM messages")).toEqual(["once"])
  })

  test("a sender's name is remembered, with their number when the envelope has it", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "hi" }, { sourceName: "Alice", sourceNumber: NUMBER }))
    expect(rowsOf(t.mirror, "SELECT uuid, number, profile_name FROM contacts")).toEqual([
      { uuid: ALICE, number: NUMBER, profile_name: "Alice" },
    ])
  })

  test("the account's own name is not stored as a contact", () => {
    t.ingest(dataFrom(ME, 1000, { message: "hi" }, { sourceName: "Me" }))
    expect(columnOf(t.mirror, "SELECT uuid FROM contacts")).toEqual([])
    expect(messageRow(t.mirror, ME, 1000)).toMatchObject({ from_me: 1, chat: ME })
  })

  test("a sender known only by number is found through the contacts", () => {
    upsertContacts(t.mirror, [{ uuid: ALICE, number: NUMBER }], NOW)
    t.ingest(envelopeFrom(undefined, { dataMessage: { timestamp: 1000, message: "hi" }, sourceNumber: NUMBER }))
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ chat: ALICE, body: "hi" })
  })

  test("a sender known by neither is ignored", () => {
    const payload = envelopeFrom(undefined, {
      dataMessage: { timestamp: 1000, message: "hi" },
      sourceNumber: NUMBER,
    })
    expect(t.ingest(payload)).toEqual([["ignored"]])
    expect(columnOf(t.mirror, "SELECT body FROM messages")).toEqual([])
  })
})

describe("what a message carries", () => {
  test("attachments keep their id, type, name, size, caption and voice mark", () => {
    t.ingest(
      dataFrom(ALICE, 1000, {
        attachments: [
          { id: "abc.png", contentType: "image/png", filename: "cat.png", size: 12, caption: "a cat", junk: 1 },
          { id: "voice.m4a", contentType: "audio/mp4", isVoiceNote: true },
          "not an attachment",
        ],
      }),
    )
    const stored = JSON.parse(messageRow(t.mirror, ALICE, 1000)?.attachments as string)
    expect(stored).toEqual([
      { id: "abc.png", type: "image/png", name: "cat.png", size: 12, caption: "a cat" },
      { id: "voice.m4a", type: "audio/mp4", voice: true },
    ])
  })

  test("a quote keeps its message's time, author, text and mentions", () => {
    t.ingest(
      dataFrom(ALICE, 1000, {
        message: "yes",
        quote: {
          id: 900,
          authorUuid: ME.toUpperCase(),
          authorNumber: NUMBER,
          text: "shall we?",
          mentions: [{ uuid: BOB, start: 0, length: 1 }],
        },
      }),
    )
    expect(JSON.parse(messageRow(t.mirror, ALICE, 1000)?.quote as string)).toEqual({
      id: 900,
      author: ME,
      text: "shall we?",
      mentions: [{ start: 0, uuid: BOB }],
    })
  })

  test("a quote keeps its files' types and names, never their thumbnails", () => {
    t.ingest(
      dataFrom(ALICE, 1000, {
        message: "yes",
        quote: {
          id: 900,
          authorUuid: ME,
          attachments: [
            { contentType: "image/png", filename: "a.png", thumbnail: { id: "preview", file: "/private/preview" } },
            { contentType: "video/mp4" },
            { filename: "notes.txt" },
            null,
            "not a file",
            { contentType: 7, filename: false },
            { contentType: "", filename: "" },
          ],
        },
      }),
    )
    expect(JSON.parse(messageRow(t.mirror, ALICE, 1000)?.quote as string)).toEqual({
      id: 900,
      author: ME,
      text: null,
      attachments: [{ type: "image/png", name: "a.png" }, { type: "video/mp4" }, { name: "notes.txt" }],
    })
  })

  test("a quote with no usable files leaves attachments absent", () => {
    t.ingest(
      dataFrom(ALICE, 1000, {
        message: "yes",
        quote: { id: 900, authorUuid: ME, attachments: [null, [], { contentType: 7 }, { filename: "" }] },
      }),
    )
    expect(JSON.parse(messageRow(t.mirror, ALICE, 1000)?.quote as string)).toEqual({
      id: 900,
      author: ME,
      text: null,
    })
  })

  test("a quote without a time is dropped", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "yes", quote: { text: "no id" } }))
    expect(messageRow(t.mirror, ALICE, 1000)?.quote).toBeNull()
  })

  test("mentions are kept in text order, by account id or number only", () => {
    t.ingest(
      dataFrom(ALICE, 1000, {
        message: "\ufffc and \ufffc and \ufffc",
        mentions: [
          { uuid: BOB.toUpperCase(), number: NUMBER, start: 8, length: 1 },
          { number: NUMBER, start: 16, length: 1 },
          { uuid: ME, start: 0, length: 1 },
          { uuid: ME, length: 1 },
        ],
      }),
    )
    expect(JSON.parse(messageRow(t.mirror, ALICE, 1000)?.mentions as string)).toEqual([
      { start: 0, uuid: ME },
      { start: 8, uuid: BOB, number: NUMBER },
      { start: 16, number: NUMBER },
    ])
  })

  test("a sticker is a message without text", () => {
    expect(t.ingest(dataFrom(ALICE, 1000, { sticker: { packId: "x", stickerId: 1 } }))).toEqual([["message"]])
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ sticker: 1, body: null })
  })

  test("kinds the mirror does not read are stored as other", () => {
    const kinds = ["pollCreate", "contacts", "payment", "pollVote", "pollTerminate", "pinMessage"]
    t.ingest(...kinds.map((kind, i) => dataFrom(ALICE, 1000 + i, { [kind]: { any: "thing" } })))
    expect(columnOf(t.mirror, "SELECT other FROM messages ORDER BY ts")).toEqual(kinds)
  })

  test("view-once and a disappearing timer are kept and marked, the timer not yet started", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "secret", viewOnce: true, expiresInSeconds: 60 }))
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({
      view_once: 1,
      expires_in: 60,
      expire_start: null,
      body: "secret",
    })
  })

  test("an empty message stores nothing", () => {
    expect(t.ingest(dataFrom(ALICE, 1000, { message: "" }), dataFrom(ALICE, 1001, { attachments: [] }))).toEqual([
      ["ignored"],
      ["ignored"],
    ])
    expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([])
  })
})

describe("expiration timer updates", () => {
  test("set the chat's timer and leave a marker message", () => {
    expect(t.ingest(dataFrom(ALICE, 1000, { isExpirationUpdate: true, expiresInSeconds: 3600 }))).toEqual([["timer"]])
    expect(rowsOf(t.mirror, "SELECT id, expires_in FROM chats")).toEqual([{ id: ALICE, expires_in: 3600 }])
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ kind: "timer", expires_in: 3600, body: null })
  })

  test("switching the timer off sets it to zero", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { isExpirationUpdate: true, expiresInSeconds: 3600 }),
      dataFrom(ALICE, 2000, { isExpirationUpdate: true }),
    )
    expect(columnOf(t.mirror, "SELECT expires_in FROM chats")).toEqual([0])
  })
})

describe("group updates and input that is not what signal-cli sends", () => {
  test("a group update without text marks the groups stale", () => {
    expect(t.ingest(groupDataFrom(ALICE, 1000, { groupInfo: { groupId: GROUP_ID, type: "UPDATE" } }))).toEqual([
      ["group-update"],
    ])
    expect(getMeta(t.mirror)).toEqual({ groups_stale: "1" })
    expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([])
  })

  test("a message with a malformed group id is not filed under the sender", () => {
    const payload = dataFrom(ALICE, 1000, { message: "hi", groupInfo: { groupId: "not a group id" } })
    expect(t.ingest(payload)).toEqual([["ignored"]])
    expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([])
  })

  test("junk is ignored without throwing", () => {
    const junk = [undefined, null, 7, "x", [], {}, { envelope: null }, { envelope: [] }]
    expect(t.ingest(...junk)).toEqual([
      ["no-envelope"],
      ["no-envelope"],
      ["no-envelope"],
      ["no-envelope"],
      ["no-envelope"],
      ["no-envelope"],
      ["no-envelope"],
      ["no-envelope"],
    ])
    const odd = [
      envelopeFrom(ALICE, { dataMessage: "text" }),
      envelopeFrom(ALICE, { dataMessage: { timestamp: "1", message: "x" } }),
      envelopeFrom(ALICE, { dataMessage: { timestamp: 1.5, message: "x", attachments: 3, mentions: "m", quote: [] } }),
      envelopeFrom(ALICE, { syncMessage: { sentMessage: 1, readMessages: "r", type: 5 } }),
      envelopeFrom(ALICE, { editMessage: { targetSentTimestamp: "x" } }),
    ]
    expect(t.ingest(...odd).flat()).toEqual(["ignored", "ignored", "ignored", "ignored", "edit-skipped"])
  })
})
