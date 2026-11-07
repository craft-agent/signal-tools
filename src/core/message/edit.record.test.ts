import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, BOB, deleteFrom, ME, rowsOf } from "../signal/mirror.testing"
import { formatLocalTime } from "../time"
import { AT, createActionFixture, OWN, type ActionFixture } from "./action.testing"
import { accepted, recipientResult, SENT } from "./send.testing"

const NOT_RECORDED = "the edit was sent but is not in the mirror yet"
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

const messages = () => rowsOf(t.mirror, "SELECT * FROM messages ORDER BY author, ts")
const versions = () => rowsOf(t.mirror, "SELECT * FROM edits ORDER BY author, ts, rev_ts")

/** The stored message at `ts` without what differs between two messages: its time and when it was received. */
function stored(ts: number): Record<string, unknown> {
  const { ts: _ts, received: _received, ...row } = rowsOf(t.mirror, "SELECT * FROM messages WHERE ts = ?", ts)[0]!
  return row
}

/** The earlier versions of the message at `ts`, without the time they differ by. */
function earlier(ts: number): Record<string, unknown>[] {
  return rowsOf(t.mirror, "SELECT * FROM edits WHERE ts = ? ORDER BY rev_ts", ts).map(
    ({ ts: _ts, rev_ts: _revTs, ...row }) => row,
  )
}

describe("an edit that Signal accepted", () => {
  test("is shown by a chat read as the message's text, edited, with the first text as an earlier version", async () => {
    const result = await t.edit({ chat: ALICE, id: ID, text: "second" })
    expect(result.errors).toBeUndefined()
    const entry = (await t.messages(ALICE)).find((message) => message.id === ID)
    expect(entry).toMatchObject({ from: "me", text: "second", edited_at: formatLocalTime(SENT) })
    expect(entry?.earlier_versions).toHaveLength(1)
    expect(entry?.earlier_versions?.[0]).toMatchObject({ text: "first" })
  })

  test("is stored exactly as the edit of a message from another device is", async () => {
    t.ownMessage(OWN + 10, { message: "first" })
    await t.edit({ chat: ALICE, id: ID, text: "second" })
    t.ownEdit(OWN + 10, SENT, "second")
    expect(stored(OWN)).toEqual(stored(OWN + 10))
    expect(stored(OWN)).toMatchObject({ body: "second", edited: SENT })
    expect(earlier(OWN)).toEqual(earlier(OWN + 10))
    expect(earlier(OWN)).toHaveLength(1)
  })

  test("a second edit is stored as that of another device is, with both earlier versions", async () => {
    t.ownMessage(OWN + 10, { message: "first" })
    await t.edit({ chat: ALICE, id: ID, text: "second" })
    t.ownEdit(OWN + 10, SENT, "second")
    await t.serve({
      result: { timestamp: SENT + 1, results: [{ recipientAddress: { uuid: ALICE }, type: "SUCCESS" }] },
    })
    await t.edit({ chat: ALICE, id: ID, text: "third" })
    t.ownEdit(OWN + 10, SENT + 1, "third")
    expect(stored(OWN)).toEqual(stored(OWN + 10))
    expect(earlier(OWN)).toHaveLength(2)
    expect(earlier(OWN).map((row) => row.body)).toEqual(["first", "second"])
    expect(earlier(OWN)).toEqual(earlier(OWN + 10))
  })

  test("takes the message's quote along unchanged and drops its mentions, as the new text is plain", async () => {
    const mentions = [{ start: 0, length: 1, uuid: BOB }]
    t.ownMessage(OWN + 1, {
      message: "\uFFFC thanks",
      mentions,
      quote: { id: 5000, authorUuid: ALICE, text: "hello from Alice" },
    })
    const before = stored(OWN + 1)
    await t.edit({ chat: ALICE, id: messageId(ME, OWN + 1), text: "thanks" })
    expect(stored(OWN + 1)).toEqual({ ...before, body: "thanks", edited: SENT, mentions: null })
    expect(earlier(OWN + 1)).toEqual([expect.objectContaining({ body: "\uFFFC thanks", mentions: before.mentions })])
    expect(before.mentions).not.toBeNull()
  })

  test("in a group is recorded in the group's message", async () => {
    t.ownMessage(OWN + 1, { message: "hello team" }, GROUP)
    await t.edit({ chat: GROUP, id: messageId(ME, OWN + 1), text: "hello again" })
    expect(stored(OWN + 1)).toMatchObject({ body: "hello again", edited: SENT })
  })
})

describe("an edit that failed or may have", () => {
  test("by an answer lost after the write is uncertain, and the mirror keeps the first text", async () => {
    await t.serve("close")
    const before = { messages: messages(), versions: versions() }
    await expect(t.edit({ chat: ALICE, id: ID, text: "second" })).rejects.toMatchObject({
      code: "uncertain",
      message: "The edit may have gone out. Check the chat on the phone before editing again.",
    })
    expect({ messages: messages(), versions: versions() }).toEqual(before)
  })

  test("by a rate limit is rate_limited, and the mirror keeps the first text", async () => {
    await t.serve({ error: { code: -5, message: "Rate limited" } })
    const before = messages()
    await expect(t.edit({ chat: ALICE, id: ID, text: "second" })).rejects.toMatchObject({ code: "rate_limited" })
    expect(messages()).toEqual(before)
  })

  test("without a daemon is an error, and the mirror keeps the first text", async () => {
    rmSync(t.paths.socket)
    const before = messages()
    await expect(t.edit({ chat: ALICE, id: ID, text: "second" })).rejects.toMatchObject({ code: "upstream_error" })
    expect(messages()).toEqual(before)
  })
})

describe("a record that fails", () => {
  test.each([
    ["the version's insert", "BEFORE INSERT ON edits"],
    ["the message's update, after the first text was kept", "BEFORE UPDATE ON messages"],
  ])("at %s rolls back and says so under errors", async (_name, when) => {
    t.mirror.exec(`CREATE TRIGGER stop ${when} BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const before = { messages: messages(), versions: versions() }
    const result = await t.edit({ chat: ALICE, id: ID, text: "second" })
    expect(result).toMatchObject({ id: ID, chat: ALICE, time: formatLocalTime(SENT), edits_left: 9 })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(result.errors?.record).not.toContain("boom")
    expect({ messages: messages(), versions: versions() }).toEqual(before)
  })

  test("a message deleted while the edit was under way is not brought back", async () => {
    await t.serve(() => {
      t.ingest(deleteFrom(ME, OWN))
      return accepted(ALICE)
    })
    const result = await t.edit({ chat: ALICE, id: ID, text: "second" })
    expect(result.errors?.record).toBe(
      "upstream_error: the edit was sent, but the message has since been deleted for everyone",
    )
    expect(result.errors?.record).not.toContain(NOT_RECORDED)
    expect(messages().filter((row) => row.ts === OWN)).toEqual([])
    expect(versions()).toEqual([])
  })

  test("a mirror of another version is left alone", async () => {
    await t.serve(() => {
      t.mirror.exec("PRAGMA user_version = 99")
      return accepted(ALICE)
    })
    const before = messages()
    const result = await t.edit({ chat: ALICE, id: ID, text: "second" })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(result.errors?.record).toContain("newer version")
    expect(messages()).toEqual(before)
  })

  test("a mirror that has gone missing is reported, and no file is created", async () => {
    await t.serve(() => {
      rmSync(t.paths.mirror)
      return accepted(ALICE)
    })
    const result = await t.edit({ chat: ALICE, id: ID, text: "second" })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(existsSync(t.paths.mirror)).toBe(false)
  })
})
