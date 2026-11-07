import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, BOB, GROUP_ID, ME, reactionFrom } from "../signal/mirror.testing"
import { AT, createActionFixture, OWN, reactionData, type ActionFixture } from "./action.testing"
import { accepted, recipientResult, SENT } from "./send.testing"

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

/** Alice's message in her chat, which the sample chats hold. */
const THEIRS = messageId(ALICE, 5000)

describe("a reaction to a message in a chat with a person", () => {
  test("to the other person's message names its author and time, and answers with the message and the emoji", async () => {
    const result = await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(t.requestParams("sendReaction")).toEqual({
      recipient: [ALICE],
      emoji: "👍",
      targetAuthor: ALICE,
      targetTimestamp: 5000,
    })
    expect(result).toEqual({ id: THEIRS, chat: ALICE, emoji: "👍" })
  })

  test("to the user's own message names the user as its author", async () => {
    const result = await t.react({ chat: ALICE, id: messageId(ME, OWN), emoji: "❤️" })
    expect(t.requestParams("sendReaction")).toEqual({
      recipient: [ALICE],
      emoji: "❤️",
      targetAuthor: ME,
      targetTimestamp: OWN,
    })
    expect(result).toEqual({ id: messageId(ME, OWN), chat: ALICE, emoji: "❤️" })
  })

  test("takes a message however old it is, and a view-once one", async () => {
    t.ownMessage(OWN + 1, { message: "once", viewOnce: true })
    await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    await t.react({ chat: ALICE, id: messageId(ME, OWN + 1), emoji: "👍" })
    expect(t.daemon().calls.map((call) => (call.params as Record<string, unknown>).targetTimestamp)).toEqual([
      5000,
      OWN + 1,
    ])
  })

  test.each(["👍", "👍🏽", "❤️", "👨‍👩‍👧", "🇯🇵", "1️⃣", "#️⃣", "🏴󠁧󠁢󠁥󠁮󠁧󠁿"])("sends the emoji %s as it is", async (emoji) => {
    await t.react({ chat: ALICE, id: THEIRS, emoji })
    expect(t.requestParams("sendReaction")).toMatchObject({ emoji })
  })

  test("of an account that is not linked is not_found", async () => {
    await expect(t.react({ account: "other", chat: ALICE, id: THEIRS, emoji: "👍" })).rejects.toMatchObject({
      code: "not_found",
    })
    expect(t.daemon().calls).toEqual([])
  })
})

describe("a reaction in a group", () => {
  const GROUP_MESSAGE = messageId(ALICE, 2000)

  test("names the group by its id and says how many members it reached", async () => {
    await t.serve({
      result: { timestamp: SENT, results: [recipientResult(ALICE), recipientResult(BOB, "NETWORK_FAILURE")] },
    })
    const result = await t.react({ chat: GROUP, id: GROUP_MESSAGE, emoji: "😂" })
    expect(t.requestParams("sendReaction")).toEqual({
      groupId: GROUP_ID,
      emoji: "😂",
      targetAuthor: ALICE,
      targetTimestamp: 2000,
    })
    expect(result).toEqual({
      id: GROUP_MESSAGE,
      chat: GROUP,
      emoji: "😂",
      reached: 1,
      not_reached: [{ id: BOB, reason: "network failure; it may still arrive" }],
    })
  })
})

describe("a reaction in Note to Self", () => {
  test("is flagged as Note to Self and answered with its time only", async () => {
    await t.serve({ result: { timestamp: SENT } })
    const result = await t.react({ chat: ME, id: messageId(ME, 4000), emoji: "👍" })
    expect(t.requestParams("sendReaction")).toEqual({
      noteToSelf: true,
      emoji: "👍",
      targetAuthor: ME,
      targetTimestamp: 4000,
    })
    expect(result).toEqual({ id: messageId(ME, 4000), chat: ME, emoji: "👍" })
  })
})

describe("replacing a reaction", () => {
  test("sets the new emoji without removing the earlier one, as Signal replaces it", async () => {
    t.ownMessage(OWN + 500, reactionData(ALICE, 5000, "❤️"))
    const result = await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(t.requestParams("sendReaction")).toEqual({
      recipient: [ALICE],
      emoji: "👍",
      targetAuthor: ALICE,
      targetTimestamp: 5000,
    })
    expect(result).toEqual({ id: THEIRS, chat: ALICE, emoji: "👍" })
  })

  test("another person's reaction to the message is not the user's", async () => {
    t.ingest(reactionFrom(ALICE, 5000, ALICE, "👍"))
    await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(t.daemon().calls).toHaveLength(1)
  })
})

describe("removing a reaction", () => {
  beforeEach(() => {
    t.ownMessage(OWN + 500, reactionData(ALICE, 5000, "❤️"))
  })

  test("without an emoji removes the current one", async () => {
    const result = await t.react({ chat: ALICE, id: THEIRS, remove: true })
    expect(t.requestParams("sendReaction")).toEqual({
      recipient: [ALICE],
      emoji: "❤️",
      targetAuthor: ALICE,
      targetTimestamp: 5000,
      remove: true,
    })
    expect(result).toEqual({ id: THEIRS, chat: ALICE, emoji: "❤️", removed: true })
  })

  test("with the current emoji removes it", async () => {
    const result = await t.react({ chat: ALICE, id: THEIRS, emoji: "❤️", remove: true })
    expect(t.requestParams("sendReaction")).toMatchObject({ emoji: "❤️", remove: true })
    expect(result).toMatchObject({ emoji: "❤️", removed: true })
  })

  test("in a group and in Note to Self names the recipients as a reaction does", async () => {
    t.ownMessage(OWN + 501, reactionData(ALICE, 2000, "👍"), GROUP)
    await t.react({ chat: GROUP, id: messageId(ALICE, 2000), remove: true })
    expect(t.requestParams("sendReaction")).toEqual({
      groupId: GROUP_ID,
      emoji: "👍",
      targetAuthor: ALICE,
      targetTimestamp: 2000,
      remove: true,
    })
    t.ownMessage(OWN + 502, reactionData(ME, 4000, "😮"), ME)
    await t.serve({ result: { timestamp: SENT } })
    await t.react({ chat: ME, id: messageId(ME, 4000), remove: true })
    expect(t.requestParams("sendReaction")).toEqual({
      noteToSelf: true,
      emoji: "😮",
      targetAuthor: ME,
      targetTimestamp: 4000,
      remove: true,
    })
  })
})
