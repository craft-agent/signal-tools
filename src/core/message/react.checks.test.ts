import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { OTHER_GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, BOB, deleteFrom, dataFrom, ME, sentTo } from "../signal/mirror.testing"
import { AT, createActionFixture, OWN, reactionData, type ActionFixture } from "./action.testing"
import { accepted } from "./send.testing"

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

const THEIRS = messageId(ALICE, 5000)

/** Expects the call to be refused with `code` and `message`, before anything is sent. */
async function expectRefused(args: Record<string, unknown>, code: string, message?: string): Promise<void> {
  const error = await t.reactFailure({ chat: ALICE, id: THEIRS, emoji: "👍", ...args })
  expect(error).toMatchObject({ code, ...(message ? { message } : {}) })
  expect(t.daemon().calls).toEqual([])
}

describe("the emoji", () => {
  test("is required unless the reaction is removed", async () => {
    await expectRefused({ emoji: undefined }, "invalid_argument", "emoji is required unless remove is set.")
    await expectRefused(
      { emoji: undefined, remove: false },
      "invalid_argument",
      "emoji is required unless remove is set.",
    )
  })

  test.each([
    ["two emoji", "👍👍"],
    ["an emoji and a letter", "👍a"],
    ["an emoji and blank space", "👍 "],
    ["blank space and an emoji", " 👍"],
    ["a symbol shown as text", "©"],
    ["a heart shown as text", "\u2764"],
    ["a letter", "a"],
    ["a word", "thumbs up"],
    ["a digit", "1"],
    ["a lone regional indicator", "🇯"],
    ["three regional indicators", "🇯🇵🇺"],
    ["nothing", ""],
    ["a joiner", "\u200d"],
    ["a cluster of more than 64 characters", `👍${"\u200d👍".repeat(22)}`],
  ])("%s is refused", async (_name, emoji) => {
    await expectRefused({ emoji }, "invalid_argument", "emoji must be exactly one emoji, such as 👍.")
  })

  test("a cluster just inside the 64 characters is one emoji", async () => {
    const emoji = `👍${"\u200d👍".repeat(19)}`
    expect(emoji.length).toBeLessThanOrEqual(64)
    await t.react({ chat: ALICE, id: THEIRS, emoji })
    expect(t.requestParams("sendReaction")).toMatchObject({ emoji })
  })

  test("is checked also when the reaction is removed", async () => {
    await expectRefused({ emoji: "no", remove: true }, "invalid_argument")
  })
})

describe("the reaction already there", () => {
  test("the same emoji twice is refused", async () => {
    t.ownMessage(OWN, reactionData(ALICE, 5000, "👍"))
    await expectRefused({ emoji: "👍" }, "invalid_argument", "That reaction is already there.")
  })

  test("the same emoji after the tool set it is refused", async () => {
    await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    const error = await t.reactFailure({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(error).toMatchObject({ code: "invalid_argument", message: "That reaction is already there." })
    expect(t.daemon().calls).toHaveLength(1)
  })

  test("another person's reaction with that emoji does not count", async () => {
    t.ingest(dataFrom(ALICE, 5005, reactionData(ALICE, 5000, "👍")))
    await t.react({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(t.daemon().calls).toHaveLength(1)
  })
})

describe("removing", () => {
  test("with no reaction of the user there is not_found, also with another person's there", async () => {
    t.ingest(dataFrom(ALICE, 5005, reactionData(ALICE, 5000, "👍")))
    await expectRefused({ emoji: undefined, remove: true }, "not_found", "You have not reacted to that message.")
    await expectRefused({ remove: true }, "not_found", "You have not reacted to that message.")
  })

  test("with another emoji than the current one is not_found, saying so", async () => {
    t.ownMessage(OWN, reactionData(ALICE, 5000, "❤️"))
    const error = await t.reactFailure({ chat: ALICE, id: THEIRS, emoji: "👍", remove: true })
    expect(error).toMatchObject({ code: "not_found" })
    expect(error.message).toContain("another emoji")
    expect(t.daemon().calls).toEqual([])
  })

  test("a reaction that was removed is not there to remove again", async () => {
    t.ownMessage(OWN, reactionData(ALICE, 5000, "❤️"))
    t.ownMessage(OWN + 1, reactionData(ALICE, 5000, "❤️", true))
    await expectRefused({ emoji: undefined, remove: true }, "not_found", "You have not reacted to that message.")
  })
})

describe("a message that is not found", () => {
  test("an id the mirror does not know", async () => {
    await expectRefused({ id: messageId(ALICE, 5001) }, "not_found", "No message with this id in this chat.")
  })

  test("a message of another chat", async () => {
    await expectRefused({ id: messageId(BOB, 3000) }, "not_found", "No message with this id in this chat.")
  })

  test("a timer change", async () => {
    t.ingest(sentTo(ALICE, OWN + 1, { isExpirationUpdate: true, expiresInSeconds: 3600 }))
    await expectRefused({ id: messageId(ME, OWN + 1) }, "not_found", "No message with this id in this chat.")
  })

  test("a message deleted for everyone, saying it is gone", async () => {
    t.ingest(deleteFrom(ALICE, 5000))
    await expectRefused({}, "not_found", "That message is gone; it was deleted or has disappeared.")
  })

  test("a message that has disappeared, saying it is gone", async () => {
    t.ownMessage(OWN, { message: "short", expiresInSeconds: 30 })
    await expectRefused(
      { id: messageId(ME, OWN) },
      "not_found",
      "That message is gone; it was deleted or has disappeared.",
    )
  })

  test("a chat the mirror does not have", async () => {
    await expectRefused({ chat: BOB.replace(/3/g, "7") }, "not_found", "No chat with this id in this account's mirror.")
  })
})

describe("the chat and the arguments", () => {
  test("a group the user left is forbidden", async () => {
    await expectRefused({ chat: OTHER_GROUP }, "forbidden", "You left this group; you can no longer send to it.")
  })

  test("a mirror that does not know the user's own id yet cannot react", async () => {
    t.mirror.exec("DELETE FROM meta WHERE key = 'account_uuid'")
    await expectRefused({}, "upstream_error")
  })

  test.each(["Alice", `${ME}:abc`, ""])("id %j is not a message id", async (id) => {
    await expectRefused({ id }, "invalid_argument")
  })

  test("an argument the tool does not take, and a remove that is not a boolean", async () => {
    await expectRefused({ text: "x" }, "invalid_argument")
    await expectRefused({ remove: "yes" }, "invalid_argument")
  })
})
