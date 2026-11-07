import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, ME, NUMBER, dataFrom, sentTo } from "../signal/mirror.testing"
import { formatLocalTime } from "../time"
import { BOB_NUMBER, CAROL, createChatFixture, type ChatFixture } from "./read.testing"

const PLACEHOLDER = "\uFFFC"
const T = Date.UTC(2026, 10, 7, 5)

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.contacts({ uuid: ALICE, name: "Alice" }, { uuid: BOB, name: "Bob", number: BOB_NUMBER })
})

afterEach(() => {
  t.close()
})

async function only(): Promise<Awaited<ReturnType<ChatFixture["messages"]>>[number]> {
  const [message, ...rest] = await t.messages(ALICE)
  expect(rest).toEqual([])
  if (!message) throw new Error("expected a message")
  return message
}

describe("chat read: message text and mentions", () => {
  test("writes each mention as @name: a contact, the user, an unknown account, a bare number", async () => {
    t.contacts({ uuid: ME, number: NUMBER })
    const text = [BOB, ME, CAROL, "number", NUMBER].map(() => PLACEHOLDER).join(" ")
    t.ingest(
      dataFrom(ALICE, T, {
        message: text,
        mentions: [
          { uuid: BOB, number: BOB_NUMBER, start: 0, length: 1 },
          { uuid: ME, number: NUMBER, start: 2, length: 1 },
          { uuid: CAROL, start: 4, length: 1 },
          { number: "+15555550166", start: 6, length: 1 },
          { number: NUMBER, start: 8, length: 1 },
        ],
      }),
    )
    const message = await only()
    expect(message.text).toBe(`@Bob @me @${CAROL} @+15555550166 @me`)
    expect(JSON.stringify(message)).not.toContain(NUMBER)
  })

  test("keeps the text around mentions, and the exact text of a message without any", async () => {
    const message = `Hi ${PLACEHOLDER}, see\n"this" ${PLACEHOLDER}!`
    t.ingest(
      dataFrom(ALICE, T, {
        message,
        mentions: [
          { uuid: BOB, start: message.indexOf(PLACEHOLDER), length: 1 },
          { uuid: CAROL, start: message.lastIndexOf(PLACEHOLDER), length: 1 },
        ],
      }),
      dataFrom(ALICE, T + 1, { message: "  Ünïcode 🙂 — as sent \n" }),
    )
    const [first, second] = await t.messages(ALICE)
    expect(first?.text).toBe(`Hi @Bob, see\n"this" @${CAROL}!`)
    expect(second?.text).toBe("  Ünïcode 🙂 — as sent \n")
  })

  test("a range is a UTF-16 offset: an emoji before a mention counts as two", async () => {
    const message = `😀 ${PLACEHOLDER} 👍👍 ${PLACEHOLDER}`
    expect([message.indexOf(PLACEHOLDER), message.lastIndexOf(PLACEHOLDER)]).toEqual([3, 10])
    t.ingest(
      dataFrom(ALICE, T, {
        message,
        mentions: [
          { uuid: BOB, start: 3, length: 1 },
          { uuid: CAROL, start: 10, length: 1 },
        ],
      }),
      dataFrom(ALICE, T + 1, { message: `😀 ${PLACEHOLDER}`, mentions: [{ uuid: BOB, start: 2, length: 1 }] }),
    )
    expect((await t.messages(ALICE)).map((entry) => entry.text)).toEqual([
      `😀 @Bob 👍👍 @${CAROL}`,
      `😀 ${PLACEHOLDER}`,
    ])
  })

  test("a range that sits on no placeholder, and a placeholder with no range, leave the text as it was", async () => {
    t.ingest(
      dataFrom(ALICE, T, { message: `ab${PLACEHOLDER}`, mentions: [{ uuid: BOB, start: 0, length: 1 }] }),
      dataFrom(ALICE, T + 1, { message: `${PLACEHOLDER}x` }),
    )
    expect((await t.messages(ALICE)).map((message) => message.text)).toEqual([`ab${PLACEHOLDER}`, `${PLACEHOLDER}x`])
  })

  test("names the sender: a contact, else the profile name sent with the message, else the account id", async () => {
    t.ingest(
      dataFrom(ALICE, T, { message: "one" }),
      dataFrom(CAROL, T + 1, { message: "two" }, { sourceName: "Carol C" }),
      dataFrom("55555555-5555-4555-8555-555555555555", T + 2, { message: "three" }),
    )
    const froms = await Promise.all(
      [ALICE, CAROL, "55555555-5555-4555-8555-555555555555"].map(async (chat) => (await t.messages(chat))[0]),
    )
    expect(froms.map((message) => [message?.from, message?.from_id])).toEqual([
      ["Alice", ALICE],
      ["Carol C", CAROL],
      ["55555555-5555-4555-8555-555555555555", "55555555-5555-4555-8555-555555555555"],
    ])
  })
})

describe("chat read: files, stickers, view once, unsupported kinds and replies", () => {
  test("a file is its name, type, size and caption, a voice note is marked, and no id or path shows", async () => {
    t.ingest(
      dataFrom(ALICE, T, {
        message: "see",
        attachments: [
          { id: "stored-id-1.png", contentType: "image/png", filename: "cat.png", size: 123, caption: "a cat" },
          { id: "stored-id-2.m4a", contentType: "audio/aac", isVoiceNote: true },
          { id: "stored-id-3" },
        ],
      }),
    )
    const message = await only()
    expect(message.files).toEqual([
      { name: "cat.png", type: "image/png", size: 123, caption: "a cat" },
      { type: "audio/aac", voice_note: true },
      {},
    ])
    expect(JSON.stringify(message)).not.toContain("stored-id")
  })

  test("a message of files only has no text", async () => {
    t.ingest(dataFrom(ALICE, T, { attachments: [{ id: "x", contentType: "image/png" }] }))
    expect(await only()).toEqual({
      id: `${ALICE}:${T}`,
      time: formatLocalTime(T),
      from: "Alice",
      from_id: ALICE,
      files: [{ type: "image/png" }],
    })
  })

  test("a sticker is marked", async () => {
    t.ingest(dataFrom(ALICE, T, { sticker: { packId: "p", stickerId: 1 } }))
    expect(await only()).toMatchObject({ sticker: true })
    expect(await only()).not.toHaveProperty("text")
  })

  test("view once is marked and carries the private note", async () => {
    t.ingest(dataFrom(ALICE, T, { viewOnce: true, attachments: [{ id: "v", contentType: "image/jpeg" }] }))
    const message = await only()
    expect(message.view_once).toBe(true)
    expect(message.private_note).toBe(
      "Its sender meant it not to be kept: show it to the user only, and do not quote or pass it on unless the user asks.",
    )
    expect(message).not.toHaveProperty("disappears_after_seconds")
  })

  test.each(["pollCreate", "contacts", "payment", "pollVote", "pollTerminate", "pinMessage"])(
    "a %s message is marked unsupported, with the pointer to the phone",
    async (kind) => {
      t.ingest(dataFrom(ALICE, T, { [kind]: { any: "thing" } }))
      const message = await only()
      expect(message.unsupported).toBe(kind)
      expect(message.unsupported_note).toBe("This kind of message is not readable here; see it on the phone.")
      expect(message).not.toHaveProperty("text")
    },
  )

  test("a reply names the quoted message's id and its text, with mentions written out", async () => {
    t.ingest(
      dataFrom(ALICE, T + 10, {
        message: "answer",
        quote: {
          id: T,
          authorUuid: BOB,
          text: `hey ${PLACEHOLDER}`,
          mentions: [{ uuid: ALICE, start: 4, length: 1 }],
        },
      }),
    )
    expect((await only()).reply_to).toEqual({ id: `${BOB}:${T}`, text: "hey @Alice" })
  })

  test("a quote without an author has a null id, and one without text a null text", async () => {
    t.ingest(
      dataFrom(ALICE, T, { message: "a", quote: { id: T - 5, text: "orig" } }),
      sentTo(ALICE, T + 1, { message: "b", quote: { id: T - 9, authorUuid: ME } }),
    )
    const [first, second] = await t.messages(ALICE)
    expect(first?.reply_to).toEqual({ id: null, text: "orig" })
    expect(second?.reply_to).toEqual({ id: `${ME}:${T - 9}`, text: null })
  })

  test("a message without any of these has none of their fields", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "plain" }))
    expect(Object.keys(await only()).sort()).toEqual(["from", "from_id", "id", "text", "time"])
  })
})
