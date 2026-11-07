import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { rmSync } from "node:fs"
import { GROUP, OTHER_GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, BOB, deleteFrom, ME, GROUP_ID } from "../signal/mirror.testing"
import { ACTION_WINDOW_MS, MAX_EDITS } from "./constants"
import { AT, createActionFixture, OWN, type ActionFixture } from "./action.testing"
import { accepted, failedEverywhere, recipientResult, SENT } from "./send.testing"

const ID = messageId(ME, OWN)
const UNCERTAIN = "The message may have been deleted for everyone. Check the chat on the phone before deleting again."

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

/** Expects the delete to be refused with `code` and `message`, before anything is sent. */
async function expectRefused(args: Record<string, unknown>, code: string, message?: string): Promise<void> {
  const error = await t.removeFailure({ chat: ALICE, id: ID, ...args })
  expect(error).toMatchObject({ code, ...(message ? { message } : {}) })
  expect(t.daemon().calls).toEqual([])
}

describe("a delete of a message to a person", () => {
  test("asks for the sent time to be deleted for the person, and answers with the message's id", async () => {
    const result = await t.remove({ chat: ALICE, id: ID })
    expect(t.requestParams("remoteDelete")).toEqual({ recipient: [ALICE], targetTimestamp: OWN })
    expect(result).toEqual({ id: ID, chat: ALICE, deleted: true })
  })

  test("of an account that is not linked is not_found", async () => {
    await expect(t.remove({ account: "other", chat: ALICE, id: ID })).rejects.toMatchObject({ code: "not_found" })
    expect(t.daemon().calls).toEqual([])
  })
})

describe("a delete in a group", () => {
  test("names the group by its id and says how many members it reached", async () => {
    t.ownMessage(OWN + 10, { message: "hello team" }, GROUP)
    await t.serve({
      result: { timestamp: SENT, results: [recipientResult(ALICE), recipientResult(BOB, "UNREGISTERED_FAILURE")] },
    })
    const result = await t.remove({ chat: GROUP, id: messageId(ME, OWN + 10) })
    expect(t.requestParams("remoteDelete")).toEqual({ groupId: GROUP_ID, targetTimestamp: OWN + 10 })
    expect(result).toEqual({
      id: messageId(ME, OWN + 10),
      chat: GROUP,
      deleted: true,
      reached: 1,
      not_reached: [{ id: BOB, reason: "not on Signal" }],
    })
  })
})

describe("a delete in Note to Self", () => {
  test("is flagged as Note to Self and answered with its time only", async () => {
    t.ownMessage(OWN + 20, { message: "remember" }, ME)
    await t.serve({ result: { timestamp: SENT } })
    const result = await t.remove({ chat: ME, id: messageId(ME, OWN + 20) })
    expect(t.requestParams("remoteDelete")).toEqual({ noteToSelf: true, targetTimestamp: OWN + 20 })
    expect(result).toEqual({ id: messageId(ME, OWN + 20), chat: ME, deleted: true })
  })
})

describe("what can be deleted", () => {
  test("a message edited the most it can be, by its first sent time", async () => {
    for (let n = 1; n <= MAX_EDITS; n += 1) t.ownEdit(OWN, OWN + n, `version ${n + 1}`)
    await t.remove({ chat: ALICE, id: ID })
    expect(t.requestParams("remoteDelete")).toEqual({ recipient: [ALICE], targetTimestamp: OWN })
  })

  test("a message with files, and a view-once message", async () => {
    t.ownMessage(OWN + 1, { message: "look", attachments: [{ id: "a1", contentType: "image/png" }] })
    t.ownMessage(OWN + 2, { message: "once", viewOnce: true })
    await t.remove({ chat: ALICE, id: messageId(ME, OWN + 1) })
    await t.remove({ chat: ALICE, id: messageId(ME, OWN + 2) })
    expect(t.daemon().calls.map((call) => (call.params as Record<string, unknown>).targetTimestamp)).toEqual([
      OWN + 1,
      OWN + 2,
    ])
  })

  test("a message sent exactly 24 hours ago", async () => {
    setSystemTime(new Date(OWN + ACTION_WINDOW_MS))
    await t.remove({ chat: ALICE, id: ID })
    expect(t.daemon().calls).toHaveLength(1)
  })
})

describe("what is refused before anything is sent", () => {
  test("another person's message", async () => {
    await expectRefused(
      { id: messageId(ALICE, 5000) },
      "forbidden",
      "Only your own messages can be deleted for everyone.",
    )
  })

  test("a message sent a millisecond more than 24 hours ago", async () => {
    setSystemTime(new Date(OWN + ACTION_WINDOW_MS + 1))
    await expectRefused({}, "forbidden", "Signal allows this only within 24 hours of sending.")
  })

  test("a message deleted already, saying it is gone", async () => {
    t.ingest(deleteFrom(ME, OWN))
    await expectRefused({}, "not_found", "That message is gone; it was deleted or has disappeared.")
  })

  test("a message that has disappeared, saying it is gone", async () => {
    t.ownMessage(OWN + 1, { message: "short", expiresInSeconds: 30 })
    await expectRefused(
      { id: messageId(ME, OWN + 1) },
      "not_found",
      "That message is gone; it was deleted or has disappeared.",
    )
  })

  test("an id the mirror does not know, and a message of another chat", async () => {
    await expectRefused({ id: messageId(ME, OWN + 1) }, "not_found", "No message with this id in this chat.")
    await expectRefused({ chat: BOB }, "not_found", "No message with this id in this chat.")
  })

  test("a group the user left", async () => {
    await expectRefused({ chat: OTHER_GROUP }, "forbidden", "You left this group; you can no longer send to it.")
  })

  test("a chat the mirror does not have", async () => {
    await expectRefused({ chat: BOB.replace(/3/g, "7") }, "not_found", "No chat with this id in this account's mirror.")
  })

  test.each(["Alice", `${ME}:abc`, ""])("id %j is not a message id", async (id) => {
    await expectRefused({ id }, "invalid_argument")
  })

  test("a missing id, and an argument the tool does not take", async () => {
    await expect(t.remove({ chat: ALICE })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(t.remove({ chat: ALICE, id: ID, text: "x" })).rejects.toMatchObject({ code: "invalid_argument" })
    expect(t.daemon().calls).toEqual([])
  })

  test("a mirror that does not know the user's own id yet", async () => {
    t.mirror.exec("DELETE FROM meta WHERE key = 'account_uuid'")
    await expectRefused({}, "upstream_error")
  })
})

describe("the outcome", () => {
  test("a rate limit keeps its code", async () => {
    await t.serve({ error: { code: -5, message: "Rate limited" } })
    await expect(t.remove({ chat: ALICE, id: ID })).rejects.toMatchObject({ code: "rate_limited" })
  })

  test("a changed safety number is forbidden, naming remoteDelete", async () => {
    await t.serve(failedEverywhere(-4, recipientResult(ALICE, "IDENTITY_FAILURE")))
    const error = await t.removeFailure({ chat: ALICE, id: ID })
    expect(error).toMatchObject({ code: "forbidden" })
    expect(error.message).toContain("remoteDelete")
  })

  test("an answer lost after the write is uncertain", async () => {
    await t.serve("close")
    expect(await t.removeFailure({ chat: ALICE, id: ID })).toMatchObject({ code: "uncertain", message: UNCERTAIN })
  })

  test("a daemon that is not running asks to start the sync service", async () => {
    rmSync(t.paths.socket)
    expect(await t.removeFailure({ chat: ALICE, id: ID })).toMatchObject({ code: "upstream_error" })
  })
})
