import { afterEach, beforeEach, expect, test } from "bun:test"
import { ME } from "../signal/mirror.testing"
import { formatLocalTime } from "../time"
import { createSendFixture, SENT, type SendFixture } from "./send.testing"

let t: SendFixture

beforeEach(() => {
  t = createSendFixture()
  t.mirror.prepare("DELETE FROM messages WHERE chat = ?").run(ME)
  t.mirror.prepare("DELETE FROM chats WHERE id = ?").run(ME)
})

afterEach(async () => {
  await t.close()
})

const ownRows = () => t.mirror.prepare("SELECT id, kind, expires_in, last_ts FROM chats WHERE id = ?").all(ME)

test("a send to Note to Self before its first message goes out and creates the chat", async () => {
  expect(ownRows()).toEqual([])
  await t.serve({ result: { timestamp: SENT } })
  const result = await t.send({ chat: ME, text: "remember" })
  expect(result).toEqual({ id: `${ME}:${SENT}`, chat: ME, time: formatLocalTime(SENT) })
  expect(t.sentParams()).toEqual({ noteToSelf: true, message: "remember" })
  expect(ownRows()).toEqual([{ id: ME, kind: "person", expires_in: 0, last_ts: SENT }])
  const messages = await t.messages(ME)
  expect(messages.map((message) => [message.id, message.text])).toEqual([[`${ME}:${SENT}`, "remember"]])
})

test("a reply to a message that does not exist in Note to Self is still not_found, and nothing is sent", async () => {
  await t.serve({ result: { timestamp: SENT } })
  const error = await t.sendFailure({ chat: ME, text: "again", reply_to: `${ME}:1000` })
  expect(error).toMatchObject({ code: "not_found", message: "No message with this id in this chat." })
  expect(t.daemon().calls.filter((call) => call.method === "send")).toEqual([])
  expect(ownRows()).toEqual([])
})
