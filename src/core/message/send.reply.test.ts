import { afterEach, beforeEach, expect, test } from "bun:test"
import { GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, BOB, deleteFrom, editFrom, groupDataFrom, ME, dataFrom, sentTo } from "../signal/mirror.testing"
import { accepted, createSendFixture, type SendFixture } from "./send.testing"

let t: SendFixture

beforeEach(async () => {
  t = createSendFixture()
  await t.serve(accepted(ALICE))
})

afterEach(async () => {
  await t.close()
})

const GONE = "That message is gone; it was deleted or has disappeared."

test("quotes the message's time, author and text", async () => {
  await t.send({ chat: ALICE, text: "got it", reply_to: messageId(ALICE, 5000) })
  expect(t.sentParams()).toEqual({
    recipient: [ALICE],
    message: "got it",
    quoteTimestamp: 5000,
    quoteAuthor: ALICE,
    quoteMessage: "hello from Alice",
  })
})

test("the quoted text is the latest edit", async () => {
  t.ingest(editFrom(ALICE, 5000, 5100, { message: "hello again" }))
  await t.send({ chat: ALICE, text: "got it", reply_to: messageId(ALICE, 5000) })
  expect(t.sentParams()).toMatchObject({ quoteTimestamp: 5000, quoteMessage: "hello again" })
})

test("quotes the user's own message by the user's own id", async () => {
  t.ingest(sentTo(ALICE, 5500, { message: "my words" }))
  await t.send({ chat: ALICE, text: "also", reply_to: messageId(ME, 5500) })
  expect(t.sentParams()).toMatchObject({ quoteAuthor: ME, quoteMessage: "my words" })
})

test("quotes in a group, by the member who wrote it", async () => {
  await t.send({ chat: GROUP, text: "agreed", reply_to: messageId(ALICE, 2000) })
  expect(t.sentParams()).toMatchObject({ quoteAuthor: ALICE, quoteMessage: "hello team" })
})

test("a message without text is quoted without quoteMessage", async () => {
  t.ingest(dataFrom(ALICE, 5600, { attachments: [{ id: "f1", contentType: "image/png", filename: "a.png" }] }))
  await t.send({ chat: ALICE, text: "nice", reply_to: messageId(ALICE, 5600) })
  const params = t.sentParams()
  expect(params).toMatchObject({ quoteTimestamp: 5600, quoteAuthor: ALICE })
  expect(params).not.toHaveProperty("quoteMessage")
})

test("a mention in the quoted text is passed along as a quote mention", async () => {
  t.ingest(
    groupDataFrom(ALICE, 2500, {
      message: "hi \uFFFC",
      mentions: [{ uuid: BOB, start: 3, length: 1 }],
    }),
  )
  await t.send({ chat: GROUP, text: "yes", reply_to: messageId(ALICE, 2500) })
  expect(t.sentParams()).toMatchObject({ quoteMessage: "hi \uFFFC", quoteMention: [`3:1:${BOB}`] })
})

test("a message deleted for everyone is not_found and nothing is sent", async () => {
  t.ingest(deleteFrom(ALICE, 5000))
  const error = await t.sendFailure({ chat: ALICE, text: "got it", reply_to: messageId(ALICE, 5000) })
  expect(error).toMatchObject({ code: "not_found", message: GONE })
  expect(t.daemon().calls).toEqual([])
})

test("an expired disappearing message is not_found, one not yet expired is quoted", async () => {
  const now = Date.now()
  t.ingest(
    sentTo(ALICE, 1000, { message: "old", expiresInSeconds: 60 }),
    sentTo(ALICE, now, { message: "fresh", expiresInSeconds: 3600 }),
  )
  const error = await t.sendFailure({ chat: ALICE, text: "x", reply_to: messageId(ME, 1000) })
  expect(error).toMatchObject({ code: "not_found", message: GONE })
  await t.send({ chat: ALICE, text: "x", reply_to: messageId(ME, now) })
  expect(t.sentParams()).toMatchObject({ quoteMessage: "fresh" })
})

test("an unknown message, one of another chat and a timer change are not_found", async () => {
  t.ingest(sentTo(ALICE, 6000, { isExpirationUpdate: true, expiresInSeconds: 60 }))
  for (const reply_to of [messageId(ALICE, 9999), messageId(BOB, 3000), messageId(ME, 6000)]) {
    const error = await t.sendFailure({ chat: ALICE, text: "x", reply_to })
    expect(error).toMatchObject({ code: "not_found", message: "No message with this id in this chat." })
  }
  expect(t.daemon().calls).toEqual([])
})

test.each(["5000", "not-an-id", `${ALICE}:0`, ""])(
  "reply_to %j that is not a message id is invalid_argument",
  async (reply_to) => {
    await expect(t.send({ chat: ALICE, text: "x", reply_to })).rejects.toMatchObject({ code: "invalid_argument" })
  },
)
