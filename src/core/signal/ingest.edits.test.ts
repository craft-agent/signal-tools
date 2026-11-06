import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ALICE,
  BOB,
  GROUP_ID,
  ME,
  OTHER_GROUP_ID,
  columnOf,
  createTestMirror,
  dataFrom,
  deleteFrom,
  editFrom,
  envelopeFrom,
  groupDataFrom,
  messageRow,
  reactionFrom,
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

function versions(): unknown[] {
  return rowsOf(t.mirror, "SELECT rev_ts, body FROM edits ORDER BY rev_ts")
}

describe("edits", () => {
  test("an edit replaces the text and keeps the earlier version", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "first" }))
    expect(t.ingest(editFrom(ALICE, 1000, 1100, { message: "second" }))).toEqual([["edit"]])
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ body: "second", edited: 1100 })
    expect(versions()).toEqual([{ rev_ts: 1000, body: "first" }])
    expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([1000])
  })

  test("several edits keep every version, whichever time the next edit names", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "v1" }),
      editFrom(ALICE, 1000, 1100, { message: "v2" }),
      editFrom(ALICE, 1100, 1200, { message: "v3" }),
      editFrom(ALICE, 1000, 1300, { message: "v4" }),
    )
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ body: "v4", edited: 1300 })
    expect(versions()).toEqual([
      { rev_ts: 1000, body: "v1" },
      { rev_ts: 1100, body: "v2" },
      { rev_ts: 1200, body: "v3" },
    ])
  })

  test("the same edit delivered again adds no version", () => {
    const edit = editFrom(ALICE, 1000, 1100, { message: "second" })
    t.ingest(dataFrom(ALICE, 1000, { message: "first" }), edit, edit)
    expect(versions()).toEqual([{ rev_ts: 1000, body: "first" }])
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ body: "second", edited: 1100 })
  })

  test("an older edit delivered again does not make the message go back", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "v1" }),
      editFrom(ALICE, 1000, 1100, { message: "v2" }),
      editFrom(ALICE, 1000, 1200, { message: "v3" }),
      editFrom(ALICE, 1000, 1100, { message: "v2" }),
      editFrom(ALICE, 1100, 1100, { message: "v2" }),
      dataFrom(ALICE, 1000, { message: "v1" }),
    )
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ body: "v3", edited: 1200 })
    expect(versions()).toEqual([
      { rev_ts: 1000, body: "v1" },
      { rev_ts: 1100, body: "v2" },
    ])
  })

  test("edits that arrive out of order leave the newest as the message and keep the rest as history", () => {
    t.ingest(
      dataFrom(ALICE, 1000, { message: "v1" }),
      editFrom(ALICE, 1000, 1200, { message: "v3" }),
      editFrom(ALICE, 1000, 1100, { message: "v2" }),
    )
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ body: "v3", edited: 1200 })
    expect(versions()).toEqual([
      { rev_ts: 1000, body: "v1" },
      { rev_ts: 1100, body: "v2" },
    ])
    t.ingest(editFrom(ALICE, 1000, 1100, { message: "v2" }), editFrom(ALICE, 1000, 1200, { message: "v3" }))
    expect(versions()).toHaveLength(2)
  })

  test("an edit keeps the files and mentions of each version, and replaces them when it brings new ones", () => {
    t.ingest(
      dataFrom(ALICE, 1000, {
        message: "\ufffc look",
        mentions: [{ uuid: BOB, start: 0, length: 1 }],
        attachments: [{ id: "one.png" }],
      }),
      editFrom(ALICE, 1000, 1100, { message: "text only" }),
      editFrom(ALICE, 1000, 1200, { message: "new file", attachments: [{ id: "two.png" }] }),
    )
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({
      body: "new file",
      attachments: '[{"id":"two.png"}]',
      mentions: null,
    })
    expect(rowsOf(t.mirror, "SELECT rev_ts, attachments, mentions FROM edits ORDER BY rev_ts")).toEqual([
      { rev_ts: 1000, attachments: '[{"id":"one.png"}]', mentions: '[{"start":0,"uuid":"' + BOB + '"}]' },
      { rev_ts: 1100, attachments: '[{"id":"one.png"}]', mentions: null },
    ])
  })

  test("an edit of a message the mirror never saw is stored as that message", () => {
    expect(t.ingest(editFrom(ALICE, 1000, 1100, { message: "only this" }))).toEqual([["edit"]])
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ chat: ALICE, body: "only this", edited: 1100 })
    expect(versions()).toEqual([])
    expect(t.ingest(editFrom(ALICE, 1000, 1100, { message: "only this" }))).toEqual([["edit"]])
    expect(versions()).toEqual([])
  })

  test("an edit in a group stays in the group; one with a bad group or no time is skipped", () => {
    t.ingest(groupDataFrom(ALICE, 1000, { message: "first" }))
    t.ingest(
      envelopeFrom(ALICE, {
        editMessage: {
          targetSentTimestamp: 1000,
          dataMessage: { timestamp: 1100, message: "second", groupInfo: { groupId: GROUP_ID } },
        },
      }),
    )
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ chat: `group:${GROUP_ID}`, body: "second" })
    const bad = envelopeFrom(ALICE, {
      editMessage: { targetSentTimestamp: 1000, dataMessage: { timestamp: 1200, groupInfo: { groupId: "bad" } } },
    })
    expect(t.ingest(bad, editFrom(ALICE, 1000, 1300, {}))).toEqual([["edit-skipped"], ["edit"]])
  })

  test("only the author can edit a message", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "mine" }))
    t.ingest(editFrom(BOB, 1000, 1100, { message: "not yours" }))
    expect(messageRow(t.mirror, ALICE, 1000)).toMatchObject({ body: "mine", edited: null })
    expect(messageRow(t.mirror, BOB, 1000)).toMatchObject({ body: "not yours" })
  })
})

describe("delete for everyone", () => {
  function attachment(id: string): string {
    const path = join(t.attachmentsDir, id)
    writeFileSync(path, "data")
    return path
  }

  test("removes the message, its files, versions, reactions and every quote of it", () => {
    const current = attachment("current.png")
    const earlier = attachment("earlier.png")
    const kept = attachment("kept.png")
    t.ingest(
      dataFrom(ALICE, 1000, { message: "v1", attachments: [{ id: "earlier.png" }] }),
      editFrom(ALICE, 1000, 1100, { message: "v2", attachments: [{ id: "current.png" }] }),
      dataFrom(BOB, 2000, { message: "re", quote: { id: 1000, authorUuid: ALICE, text: "v1" } }),
      dataFrom(BOB, 2001, { message: "re2", quote: { id: 1100, authorUuid: ALICE, text: "v2" } }),
      dataFrom(BOB, 2002, { message: "other", quote: { id: 1000, authorUuid: BOB, text: "not alice's" } }),
      dataFrom(BOB, 2003, { message: "keeps", attachments: [{ id: "kept.png" }] }),
      reactionFrom(BOB, 1000, ALICE, "👍"),
    )
    expect(t.ingest(deleteFrom(ALICE, 1000))).toEqual([["delete"]])
    expect(columnOf(t.mirror, "SELECT ts FROM messages ORDER BY ts")).toEqual([2000, 2001, 2002, 2003])
    expect(columnOf(t.mirror, "SELECT quote FROM messages ORDER BY ts").map((q) => q !== null)).toEqual([
      false,
      false,
      true,
      false,
    ])
    expect(versions()).toEqual([])
    expect(columnOf(t.mirror, "SELECT emoji FROM reactions")).toEqual([])
    expect([current, earlier].map(existsSync)).toEqual([false, false])
    expect(existsSync(kept)).toBe(true)
  })

  test("is found by the time of a revision too", () => {
    // The original, an earlier revision and the current one, each on a message of its own.
    for (const [base, offset] of [
      [1000, 0],
      [2000, 100],
      [3000, 200],
    ]) {
      t.ingest(
        dataFrom(ALICE, base, { message: "v1" }),
        editFrom(ALICE, base, base + 100, { message: "v2" }),
        editFrom(ALICE, base, base + 200, { message: "v3" }),
      )
      expect(t.ingest(deleteFrom(ALICE, base + offset))).toEqual([["delete"]])
      expect(columnOf(t.mirror, "SELECT ts FROM messages")).toEqual([])
      expect(versions()).toEqual([])
    }
  })

  test("removes a quote that names the message by a revision's time, or by no author within the chat", () => {
    t.ingest(
      groupDataFrom(ALICE, 1000, { message: "v1" }),
      envelopeFrom(ALICE, {
        editMessage: {
          targetSentTimestamp: 1000,
          dataMessage: { timestamp: 1100, message: "v2", groupInfo: { groupId: GROUP_ID } },
        },
      }),
      groupDataFrom(BOB, 2000, { message: "by revision", quote: { id: 1100, authorUuid: ALICE } }),
      groupDataFrom(BOB, 2001, { message: "no author, same chat", quote: { id: 1000 } }),
      groupDataFrom(BOB, 2002, { message: "no author, other group", quote: { id: 1000 } }, OTHER_GROUP_ID),
      dataFrom(BOB, 2003, { message: "no author, a direct chat", quote: { id: 1000 } }),
    )
    t.ingest(deleteFrom(ALICE, 1000))
    expect(columnOf(t.mirror, "SELECT quote FROM messages ORDER BY ts").map((q) => q !== null)).toEqual([
      false,
      false,
      true,
      true,
    ])
  })

  test("is the author's only: someone else's delete removes nothing", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "mine" }))
    expect(t.ingest(deleteFrom(BOB, 1000))).toEqual([["delete-early"]])
    expect(columnOf(t.mirror, "SELECT body FROM messages")).toEqual(["mine"])
  })

  test("of a message the mirror never had removes nothing, and the account's own delete works", () => {
    expect(t.ingest(deleteFrom(ALICE, 1000))).toEqual([["delete-early"]])
    t.ingest(dataFrom(ME, 1000, { message: "mine" }))
    expect(t.ingest(deleteFrom(ME, 1000))).toEqual([["delete"]])
  })
})

describe("reactions", () => {
  test("one reaction per person: added, replaced, removed", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "hi" }), reactionFrom(BOB, 1000, ALICE, "👍"))
    expect(rowsOf(t.mirror, "SELECT author, ts, reactor, emoji, at FROM reactions")).toEqual([
      { author: ALICE, ts: 1000, reactor: BOB, emoji: "👍", at: 1_800_000_000_000 },
    ])
    expect(t.ingest(reactionFrom(BOB, 1000, ALICE, "❤️"), reactionFrom(ME, 1000, ALICE, "😂"))).toEqual([
      ["reaction"],
      ["reaction"],
    ])
    expect(columnOf(t.mirror, "SELECT emoji FROM reactions ORDER BY reactor")).toEqual(["😂", "❤️"])
    t.ingest(reactionFrom(BOB, 1000, ALICE, "❤️", true))
    expect(columnOf(t.mirror, "SELECT reactor FROM reactions")).toEqual([ME])
  })

  test("a reaction naming an edited message's revision lands on the message", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "v1" }), editFrom(ALICE, 1000, 1100, { message: "v2" }))
    t.ingest(reactionFrom(BOB, 1100, ALICE, "👍"))
    expect(rowsOf(t.mirror, "SELECT ts FROM reactions")).toEqual([{ ts: 1000 }])
  })

  test("a reaction without an emoji or a readable target is ignored", () => {
    const unreadable = [
      dataFrom(BOB, 1, { reaction: { targetAuthorUuid: ALICE, targetSentTimestamp: 1000 } }),
      dataFrom(BOB, 2, { reaction: { emoji: "👍", targetAuthorUuid: "alice", targetSentTimestamp: 1000 } }),
      dataFrom(BOB, 3, { reaction: { emoji: "👍", targetAuthorUuid: ALICE } }),
    ]
    expect(t.ingest(...unreadable)).toEqual([["ignored"], ["ignored"], ["ignored"]])
  })
})
