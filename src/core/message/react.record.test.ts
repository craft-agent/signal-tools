import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, dataFrom, deleteFrom, ME, reactionFrom, rowsOf, sentTo } from "../signal/mirror.testing"
import { AT, createActionFixture, OWN, reactionData, type ActionFixture } from "./action.testing"
import { accepted } from "./send.testing"

const NOT_RECORDED = "the reaction was sent but is not in the mirror yet"
const THEIRS = messageId(ALICE, 5000)

let t: ActionFixture

beforeEach(async () => {
  t = createActionFixture()
  setSystemTime(new Date(AT))
  await t.serve(accepted(ALICE))
})

afterEach(async () => {
  setSystemTime()
  await t.close()
})

const reactions = () => rowsOf(t.mirror, "SELECT * FROM reactions ORDER BY author, ts, reactor")

/** The reactions to the message at `ts` without the time they were made. */
function reactionsTo(ts: number): Record<string, unknown>[] {
  return rowsOf(t.mirror, "SELECT * FROM reactions WHERE ts = ? ORDER BY reactor", ts).map(({ ts: _ts, ...row }) => row)
}

/** The sync message of the reaction of the user to Alice's message at `target`, made on another device. */
const syncedReaction = (target: number, emoji: string, isRemove = false) =>
  sentTo(ALICE, target + 9, reactionData(ALICE, target, emoji, isRemove))

/** The reactions a chat read shows on the message `id`. */
async function shown(chat: string, id: string) {
  return (await t.messages(chat)).find((message) => message.id === id)?.reactions
}

describe("a reaction that Signal accepted", () => {
  test("is shown by a chat read as the user's own", async () => {
    const result = await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(result.errors).toBeUndefined()
    expect(await shown(ALICE, THEIRS)).toEqual([{ from: "me", emoji: "👍" }])
    expect(rowsOf(t.mirror, "SELECT reactor, emoji, at FROM reactions")).toEqual([{ reactor: ME, emoji: "👍", at: AT }])
  })

  test("is stored exactly as the reaction of a message from another device is", async () => {
    t.ingest(dataFrom(ALICE, 5100, { message: "second" }))
    await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    t.ingestAt(AT, syncedReaction(5100, "👍"))
    expect(reactionsTo(5000)).toEqual(reactionsTo(5100))
    expect(reactionsTo(5000)).toHaveLength(1)
  })

  test("replaces the user's earlier reaction, as another person's stays", async () => {
    t.ingest(reactionFrom(ALICE, 5000, ALICE, "😂"))
    t.ownMessage(OWN, reactionData(ALICE, 5000, "❤️"))
    await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(await shown(ALICE, THEIRS)).toEqual([
      { from: "Alice", from_id: ALICE, emoji: "😂" },
      { from: "me", emoji: "👍" },
    ])
    expect(reactions()).toHaveLength(2)
  })

  test("replacing is stored as a reaction of another device replacing is", async () => {
    t.ingest(dataFrom(ALICE, 5100, { message: "second" }))
    t.ownMessage(OWN, reactionData(ALICE, 5000, "❤️"))
    t.ownMessage(OWN + 1, reactionData(ALICE, 5100, "❤️"))
    await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    t.ingestAt(AT, syncedReaction(5100, "👍"))
    expect(reactionsTo(5000)).toEqual(reactionsTo(5100))
  })

  test("to the user's own message is shown on it", async () => {
    t.ownMessage(OWN, { message: "first" })
    await t.react({ chat: ALICE, id: messageId(ME, OWN), emoji: "😮" })
    expect(await shown(ALICE, messageId(ME, OWN))).toEqual([{ from: "me", emoji: "😮" }])
  })

  test("in a group and in Note to Self is recorded in that chat's message", async () => {
    await t.react({ chat: GROUP, id: messageId(ALICE, 2000), emoji: "👍" })
    expect(await shown(GROUP, messageId(ALICE, 2000))).toEqual([{ from: "me", emoji: "👍" }])
    await t.serve({ result: { timestamp: AT } })
    await t.react({ chat: ME, id: messageId(ME, 4000), emoji: "👍" })
    expect(await shown(ME, messageId(ME, 4000))).toEqual([{ from: "me", emoji: "👍" }])
  })
})

describe("a removal that Signal accepted", () => {
  beforeEach(() => {
    t.ingest(reactionFrom(ALICE, 5000, ALICE, "😂"))
    t.ownMessage(OWN, reactionData(ALICE, 5000, "❤️"))
  })

  test("takes the user's reaction off, as another person's stays", async () => {
    const result = await t.react({ chat: ALICE, id: THEIRS, remove: true })
    expect(result.errors).toBeUndefined()
    expect(await shown(ALICE, THEIRS)).toEqual([{ from: "Alice", from_id: ALICE, emoji: "😂" }])
  })

  test("is stored as the removal from another device is", async () => {
    t.ingest(dataFrom(ALICE, 5100, { message: "second" }), reactionFrom(ALICE, 5100, ALICE, "😂"))
    t.ownMessage(OWN + 1, reactionData(ALICE, 5100, "❤️"))
    await t.react({ chat: ALICE, id: THEIRS, emoji: "❤️", remove: true })
    t.ingestAt(AT, syncedReaction(5100, "❤️", true))
    expect(reactionsTo(5000)).toEqual(reactionsTo(5100))
    expect(reactionsTo(5000)).toHaveLength(1)
  })
})

describe("a reaction that failed or may have", () => {
  test("by an answer lost after the write is uncertain, and the mirror has no reaction", async () => {
    await t.serve("close")
    await expect(t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })).rejects.toMatchObject({
      code: "uncertain",
      message: "The reaction may have gone out. Check the chat on the phone before reacting again.",
    })
    expect(reactions()).toEqual([])
  })

  test("by a rate limit is rate_limited, and the mirror has no reaction", async () => {
    await t.serve({ error: { code: -5, message: "Rate limited" } })
    await expect(t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })).rejects.toMatchObject({ code: "rate_limited" })
    expect(reactions()).toEqual([])
  })
})

describe("a record that fails", () => {
  test.each([
    ["the reaction's insert", "BEFORE INSERT ON reactions", { emoji: "👍" }],
    ["the reaction's removal", "BEFORE DELETE ON reactions", { remove: true }],
  ])("at %s rolls back and says so under errors", async (_name, when, args) => {
    t.ownMessage(OWN, reactionData(ALICE, 5000, "❤️"))
    t.mirror.exec(`CREATE TRIGGER stop ${when} BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const before = reactions()
    const result = await t.react({ chat: ALICE, id: THEIRS, ...args })
    expect(result).toMatchObject({ id: THEIRS, chat: ALICE })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(result.errors?.record).not.toContain("boom")
    expect(reactions()).toEqual(before)
  })

  test("a message deleted while the reaction was under way is not given a reaction", async () => {
    await t.serve(() => {
      t.ingest(deleteFrom(ALICE, 5000))
      return accepted(ALICE)
    })
    const result = await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(result.errors?.record).toBe(
      "upstream_error: the reaction was sent, but the message has since been deleted for everyone",
    )
    expect(reactions()).toEqual([])
  })

  test("a mirror of another version is left alone", async () => {
    await t.serve(() => {
      t.mirror.exec("PRAGMA user_version = 99")
      return accepted(ALICE)
    })
    const result = await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(result.errors?.record).toContain("newer version")
    expect(reactions()).toEqual([])
  })

  test("a mirror that has gone missing is reported, and no file is created", async () => {
    await t.serve(() => {
      rmSync(t.paths.mirror)
      return accepted(ALICE)
    })
    const result = await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(result.errors?.record).toContain(NOT_RECORDED)
    expect(existsSync(t.paths.mirror)).toBe(false)
  })
})
