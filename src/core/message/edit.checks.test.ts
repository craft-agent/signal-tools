import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { OTHER_GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, BOB, deleteFrom, ME, sentTo } from "../signal/mirror.testing"
import { AT, createActionFixture, OWN, type ActionFixture } from "./action.testing"
import { ACTION_WINDOW_MS, MAX_EDITS } from "./constants"
import { accepted } from "./send.testing"

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

/** Expects the edit to be refused with `code` and `message`, before anything is sent. */
async function expectRefused(args: Record<string, unknown>, code: string, message?: string): Promise<void> {
  const error = await t.editFailure({ chat: ALICE, id: ID, text: "second", ...args })
  expect(error).toMatchObject({ code, ...(message ? { message } : {}) })
  expect(t.daemon().calls).toEqual([])
}

describe("a message that is not found", () => {
  test("an id the mirror does not know", async () => {
    await expectRefused({ id: messageId(ME, OWN + 1) }, "not_found", "No message with this id in this chat.")
  })

  test("a message of another chat", async () => {
    await expectRefused({ chat: BOB }, "not_found", "No message with this id in this chat.")
  })

  test("a timer change", async () => {
    t.ingest(sentTo(ALICE, OWN + 1, { isExpirationUpdate: true, expiresInSeconds: 3600 }))
    await expectRefused({ id: messageId(ME, OWN + 1) }, "not_found", "No message with this id in this chat.")
  })

  test("a message deleted for everyone, saying it is gone", async () => {
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

  test("an unknown chat", async () => {
    await expectRefused({ chat: BOB.replace(/3/g, "7") }, "not_found", "No chat with this id in this account's mirror.")
  })
})

describe("a message that is not the user's to edit", () => {
  test("another person's message", async () => {
    await expectRefused({ id: messageId(ALICE, 5000) }, "forbidden", "Only your own messages can be edited.")
  })

  test("a message in a group the user left", async () => {
    await expectRefused({ chat: OTHER_GROUP }, "forbidden", "You left this group; you can no longer send to it.")
  })
})

describe("the 24 hours", () => {
  test("a message sent exactly 24 hours ago can still be edited", async () => {
    setSystemTime(new Date(OWN + ACTION_WINDOW_MS))
    await t.edit({ chat: ALICE, id: ID, text: "second" })
    expect(t.daemon().calls).toHaveLength(1)
  })

  test("a message sent a millisecond longer ago is forbidden", async () => {
    setSystemTime(new Date(OWN + ACTION_WINDOW_MS + 1))
    await expectRefused({}, "forbidden", "Signal allows this only within 24 hours of sending.")
  })

  test("is counted from the first send, not from the latest edit", async () => {
    t.ownEdit(OWN, AT - 1000, "second")
    setSystemTime(new Date(OWN + ACTION_WINDOW_MS + 1))
    await expectRefused({ text: "third" }, "forbidden", "Signal allows this only within 24 hours of sending.")
  })
})

describe("the number of edits", () => {
  test("a message edited ten times is forbidden", async () => {
    for (let n = 1; n <= MAX_EDITS; n += 1) t.ownEdit(OWN, OWN + n, `version ${n + 1}`)
    await expectRefused({ text: "one too many" }, "forbidden")
  })

  test("a message edited nine times takes the tenth, and none is left", async () => {
    for (let n = 1; n < MAX_EDITS; n += 1) t.ownEdit(OWN, OWN + n, `version ${n + 1}`)
    expect((await t.edit({ chat: ALICE, id: ID, text: "the tenth" })).edits_left).toBe(0)
  })

  test("a message never seen before its first edit counts that edit too", async () => {
    for (let n = 1; n <= MAX_EDITS; n += 1) t.ownEdit(OWN + 100, OWN + 100 + n, `version ${n + 1}`)
    await expectRefused({ id: messageId(ME, OWN + 100), text: "one too many" }, "forbidden")
  })
})

describe("a message that is more than text", () => {
  test("a message with files", async () => {
    t.ownMessage(OWN + 1, { message: "look", attachments: [{ id: "a1", contentType: "image/png", filename: "a.png" }] })
    await expectRefused(
      { id: messageId(ME, OWN + 1) },
      "invalid_argument",
      "Only a message without files can be edited.",
    )
  })

  test("a message with files and no text", async () => {
    t.ownMessage(OWN + 1, { attachments: [{ id: "a1", contentType: "image/png" }] })
    await expectRefused(
      { id: messageId(ME, OWN + 1) },
      "invalid_argument",
      "Only a message without files can be edited.",
    )
  })

  test("a view-once message", async () => {
    t.ownMessage(OWN + 1, { message: "once", viewOnce: true })
    await expectRefused({ id: messageId(ME, OWN + 1) }, "invalid_argument", "A view-once message cannot be edited.")
  })

  test("a sticker", async () => {
    t.ownMessage(OWN + 1, { sticker: { packId: "ab", stickerId: 1 } })
    await expectRefused({ id: messageId(ME, OWN + 1) }, "invalid_argument", "Only a text message can be edited.")
  })
})

test("a reply whose stored quote has neither text nor files cannot be edited", async () => {
  t.ownMessage(OWN + 1, { message: "got it", quote: { id: 5000, authorUuid: ALICE } })
  await expectRefused(
    { id: messageId(ME, OWN + 1) },
    "invalid_argument",
    "This reply's quote has no text and no file, and Signal on iPhone does not show a reply whose quote is empty, so it cannot be edited.",
  )
})

describe("the text", () => {
  test("the text the message has is refused, also with blank space around it", async () => {
    await expectRefused({ text: "first" }, "invalid_argument")
    await expectRefused({ text: " first\n" }, "invalid_argument")
  })

  test("the text of the latest edit is the one compared", async () => {
    t.ownEdit(OWN, OWN + 1, "second")
    await expectRefused({ text: "second" }, "invalid_argument")
    expect((await t.edit({ chat: ALICE, id: ID, text: "first" })).edits_left).toBe(8)
  })

  test.each(["", "  \n"])("blank text %j", async (text) => {
    await expectRefused({ text }, "invalid_argument")
  })

  test("4,001 characters", async () => {
    await expectRefused({ text: "😀".repeat(4001) }, "invalid_argument")
  })
})

describe("the arguments", () => {
  test.each(["Alice", `${ME}:abc`, `${ME}:0`, `${ME}:1:2`, ""])("id %j is not a message id", async (id) => {
    await expectRefused({ id }, "invalid_argument")
  })

  test("a missing id, and one the tool does not take", async () => {
    await expect(t.edit({ chat: ALICE, text: "second" })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(t.edit({ chat: ALICE, id: ID, text: "second", reply_to: ID })).rejects.toMatchObject({
      code: "invalid_argument",
    })
    expect(t.daemon().calls).toEqual([])
  })

  test("a mirror that does not know the user's own id yet cannot edit", async () => {
    t.mirror.exec("DELETE FROM meta WHERE key = 'account_uuid'")
    await expectRefused({}, "upstream_error")
  })
})
