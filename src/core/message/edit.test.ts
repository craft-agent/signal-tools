import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, BOB, GROUP_ID, ME } from "../signal/mirror.testing"
import { formatLocalTime } from "../time"
import { AT, createActionFixture, OWN, type ActionFixture } from "./action.testing"
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

const ID = messageId(ME, OWN)

describe("an edit of a message to a person", () => {
  test("sends the new text pointing at the sent time, and answers with the message's id and the edit's time", async () => {
    const result = await t.edit({ chat: ALICE, id: ID, text: "second" })
    expect(t.requestParams("send")).toEqual({ recipient: [ALICE], editTimestamp: OWN, message: "second" })
    expect(result).toEqual({ id: ID, chat: ALICE, time: formatLocalTime(SENT), edits_left: 9 })
  })

  test("trims the text before it is sent", async () => {
    await t.edit({ chat: ALICE, id: ID, text: " \n second \t" })
    expect(t.requestParams("send")).toMatchObject({ message: "second" })
  })

  test("takes the time of the edit from Signal's answer, not from the clock", async () => {
    await t.serve({ result: { timestamp: AT + 7, results: [recipientResult(ALICE)] } })
    expect((await t.edit({ chat: ALICE, id: ID, text: "second" })).time).toBe(formatLocalTime(AT + 7))
  })

  test("of an account that is not linked is not_found", async () => {
    await expect(t.edit({ account: "other", chat: ALICE, id: ID, text: "second" })).rejects.toMatchObject({
      code: "not_found",
    })
    expect(t.daemon().calls).toEqual([])
  })
})

describe("an edit in a group", () => {
  const GROUP_OWN = OWN + 10

  beforeEach(() => {
    t.ownMessage(GROUP_OWN, { message: "hello team" }, GROUP)
  })

  test("names the group by its id and says how many members it reached", async () => {
    await t.serve({
      result: { timestamp: SENT, results: [recipientResult(ALICE), recipientResult(BOB, "NETWORK_FAILURE")] },
    })
    const result = await t.edit({ chat: GROUP, id: messageId(ME, GROUP_OWN), text: "hello again" })
    expect(t.requestParams("send")).toEqual({ groupId: GROUP_ID, editTimestamp: GROUP_OWN, message: "hello again" })
    expect(result).toEqual({
      id: messageId(ME, GROUP_OWN),
      chat: GROUP,
      time: formatLocalTime(SENT),
      edits_left: 9,
      reached: 1,
      not_reached: [{ id: BOB, reason: "network failure; it may still arrive" }],
    })
  })
})

describe("an edit in Note to Self", () => {
  test("is flagged as Note to Self and answered with its time only", async () => {
    t.ownMessage(OWN + 20, { message: "remember" }, ME)
    await t.serve({ result: { timestamp: SENT } })
    const result = await t.edit({ chat: ME, id: messageId(ME, OWN + 20), text: "remember more" })
    expect(t.requestParams("send")).toEqual({ noteToSelf: true, editTimestamp: OWN + 20, message: "remember more" })
    expect(result).toEqual({ id: messageId(ME, OWN + 20), chat: ME, time: formatLocalTime(SENT), edits_left: 9 })
  })
})

describe("the quote of the message", () => {
  const quoted = { id: 5000, authorUuid: ALICE, text: "hello from Alice" }

  test("is sent again with the edit", async () => {
    t.ownMessage(OWN + 1, { message: "got it", quote: quoted })
    await t.edit({ chat: ALICE, id: messageId(ME, OWN + 1), text: "got it, thanks" })
    expect(t.requestParams("send")).toEqual({
      recipient: [ALICE],
      editTimestamp: OWN + 1,
      message: "got it, thanks",
      quoteTimestamp: 5000,
      quoteAuthor: ALICE,
      quoteMessage: "hello from Alice",
    })
  })

  test("is sent again with the mentions it holds", async () => {
    const mentions = [{ start: 0, length: 1, uuid: BOB }]
    t.ownMessage(OWN + 1, { message: "got it", quote: { ...quoted, text: "\uFFFC said", mentions } })
    await t.edit({ chat: ALICE, id: messageId(ME, OWN + 1), text: "got it, thanks" })
    expect(t.requestParams("send")).toMatchObject({ quoteMessage: "\uFFFC said", quoteMention: [`0:1:${BOB}`] })
  })

  test("that names no author cannot be sent again, so the edit is refused before anything is sent", async () => {
    t.ownMessage(OWN + 1, { message: "got it", quote: { id: 5000, text: "hello from Alice" } })
    const error = await t.editFailure({ chat: ALICE, id: messageId(ME, OWN + 1), text: "got it, thanks" })
    expect(error).toMatchObject({
      code: "invalid_argument",
      message: "This reply's quote cannot be sent again, so editing it would drop the quote.",
    })
    expect(t.daemon().calls).toEqual([])
  })

  test("is the one the message had first, after several edits", async () => {
    t.ownMessage(OWN + 1, { message: "got it", quote: quoted })
    await t.edit({ chat: ALICE, id: messageId(ME, OWN + 1), text: "got it, thanks" })
    await t.serve({ result: { timestamp: SENT + 1, results: [recipientResult(ALICE)] } })
    await t.edit({ chat: ALICE, id: messageId(ME, OWN + 1), text: "got it, thanks a lot" })
    expect(t.requestParams("send")).toMatchObject({ quoteTimestamp: 5000, editTimestamp: OWN + 1 })
  })
})

describe("edits_left", () => {
  test("counts down with every edit, as the mirror keeps the versions", async () => {
    expect((await t.edit({ chat: ALICE, id: ID, text: "second" })).edits_left).toBe(9)
    await t.serve({ result: { timestamp: SENT + 1, results: [recipientResult(ALICE)] } })
    expect((await t.edit({ chat: ALICE, id: ID, text: "third" })).edits_left).toBe(8)
    expect(t.daemon().calls).toHaveLength(1)
    expect(t.requestParams("send")).toMatchObject({ editTimestamp: OWN, message: "third" })
  })

  test("counts edits made on other devices, also of a message first seen as an edit", async () => {
    t.ownEdit(OWN, OWN + 100, "second")
    t.ownEdit(OWN, OWN + 200, "third")
    expect((await t.edit({ chat: ALICE, id: ID, text: "fourth" })).edits_left).toBe(7)
    t.ownEdit(OWN - 500, OWN - 400, "seen only as an edit")
    await t.serve(accepted(ALICE))
    expect((await t.edit({ chat: ALICE, id: messageId(ME, OWN - 500), text: "again" })).edits_left).toBe(8)
  })
})
