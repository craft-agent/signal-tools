import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, ME, dataFrom, editFrom, reactionFrom, sentTo, syncFromMe } from "../signal/mirror.testing"
import { formatLocalTime } from "../time"
import { createChatFixture, type ChatFixture } from "./read.testing"

const T = Date.UTC(2026, 10, 7, 5)
const PAST = 1_000_000_000_000
const FUTURE = 4_000_000_000_000
const PRIVATE_NOTE =
  "Its sender meant it not to be kept: show it to the user only, and do not quote or pass it on unless the user asks."

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.contacts({ uuid: ALICE, name: "Alice" }, { uuid: BOB, name: "Bob" })
})

afterEach(() => {
  t.close()
})

describe("chat read: edits and reactions", () => {
  test("an edited message shows its latest text, when it was edited and every earlier text oldest first", async () => {
    t.ingest(
      dataFrom(ALICE, T, { message: "first" }),
      editFrom(ALICE, T, T + 10, { message: "second" }),
      editFrom(ALICE, T, T + 20, { message: "third" }),
    )
    const [message] = await t.messages(ALICE)
    expect(message).toMatchObject({ id: `${ALICE}:${T}`, time: formatLocalTime(T), text: "third" })
    expect(message?.edited_at).toBe(formatLocalTime(T + 20))
    expect(message?.earlier_versions).toEqual([
      { time: formatLocalTime(T), text: "first" },
      { time: formatLocalTime(T + 10), text: "second" },
    ])
  })

  test("an edit of a message the mirror never saw has no earlier version to show", async () => {
    t.ingest(editFrom(ALICE, T, T + 10, { message: "only version" }))
    const [message] = await t.messages(ALICE)
    expect(message?.text).toBe("only version")
    expect(message?.edited_at).toBe(formatLocalTime(T + 10))
    expect(message).not.toHaveProperty("earlier_versions")
  })

  test("reactions say who reacted with what: the user as me, others by name and id", async () => {
    t.ingest(
      dataFrom(ALICE, T, { message: "react to me" }),
      reactionFrom(BOB, T, ALICE, "👍"),
      sentTo(ALICE, T + 7, { reaction: { emoji: "❤️", targetAuthorUuid: ALICE, targetSentTimestamp: T } }),
    )
    const [message] = await t.messages(ALICE)
    expect(message?.reactions).toHaveLength(2)
    expect(message?.reactions).toContainEqual({ from: "me", emoji: "❤️" })
    expect(message?.reactions).toContainEqual({ from: "Bob", from_id: BOB, emoji: "👍" })
  })

  test("a removed reaction is gone, and a message without reactions has no field", async () => {
    t.ingest(
      dataFrom(ALICE, T, { message: "a" }),
      dataFrom(ALICE, T + 100, { message: "b" }),
      reactionFrom(BOB, T, ALICE, "👍"),
      reactionFrom(BOB, T, ALICE, "👍", true),
    )
    for (const message of await t.messages(ALICE)) expect(message).not.toHaveProperty("reactions")
  })

  test("each message of a page keeps its own reactions and versions", async () => {
    for (let n = 0; n < 40; n += 1) {
      t.ingest(dataFrom(ALICE, T + n * 1000, { message: `m${n}` }))
      if (n % 2 === 0) t.ingest(reactionFrom(BOB, T + n * 1000, ALICE, n % 4 === 0 ? "👍" : "🎉"))
      if (n % 5 === 0) t.ingest(editFrom(ALICE, T + n * 1000, T + n * 1000 + 1, { message: `m${n} edited` }))
    }
    const messages = await t.messages(ALICE)
    expect(messages).toHaveLength(40)
    messages.forEach((message, n) => {
      expect(message.reactions?.map((reaction) => reaction.emoji)).toEqual(
        n % 2 === 0 ? [n % 4 === 0 ? "👍" : "🎉"] : undefined,
      )
      expect(message.earlier_versions?.map((version) => version.text)).toEqual(n % 5 === 0 ? [`m${n}`] : undefined)
    })
  })
})

describe("chat read: timers and disappearing messages", () => {
  test("a change of the timer reads as its own entry: 0 is off", async () => {
    t.ingest(
      dataFrom(ALICE, T, { isExpirationUpdate: true, expiresInSeconds: 3600 }),
      sentTo(ALICE, T + 1, { isExpirationUpdate: true, expiresInSeconds: 0 }),
    )
    expect(await t.messages(ALICE)).toEqual([
      { id: `${ALICE}:${T}`, time: formatLocalTime(T), from: "Alice", from_id: ALICE, timer_set_seconds: 3600 },
      { id: `${ME}:${T + 1}`, time: formatLocalTime(T + 1), from: "me", timer_set_seconds: 0 },
    ])
  })

  test("a message the user sent starts disappearing when sent; one that has passed is expired", async () => {
    t.ingest(
      sentTo(ALICE, PAST, { message: "gone", expiresInSeconds: 60 }),
      sentTo(ALICE, FUTURE, { message: "still here", expiresInSeconds: 60 }),
    )
    const [gone, here] = await t.messages(ALICE)
    expect(gone).toMatchObject({
      disappears_after_seconds: 60,
      disappears_at: formatLocalTime(PAST + 60_000),
      expired: true,
      private_note: PRIVATE_NOTE,
    })
    expect(here).toMatchObject({
      disappears_after_seconds: 60,
      disappears_at: formatLocalTime(FUTURE + 60_000),
      private_note: PRIVATE_NOTE,
    })
    expect(here).not.toHaveProperty("expired")
  })

  test("a received message has a timer, but no time to disappear, until a device reads it", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "secret", expiresInSeconds: 3600 }))
    const [unread] = await t.messages(ALICE)
    expect(unread).toMatchObject({ disappears_after_seconds: 3600, private_note: PRIVATE_NOTE })
    expect(unread).not.toHaveProperty("disappears_at")
    expect(unread).not.toHaveProperty("expired")
    t.ingestAt(FUTURE, syncFromMe({ readMessages: [{ senderUuid: ALICE, timestamp: T }] }))
    const [read] = await t.messages(ALICE)
    expect(read?.disappears_at).toBe(formatLocalTime(FUTURE + 3_600_000))
    expect(read).not.toHaveProperty("expired")
    t.ingestAt(PAST, dataFrom(ALICE, PAST, { message: "old", expiresInSeconds: 10 }))
    t.ingestAt(PAST + 5, syncFromMe({ readMessages: [{ senderUuid: ALICE, timestamp: PAST }] }))
    expect((await t.messages(ALICE))[0]).toMatchObject({ text: "old", expired: true })
  })

  test("a message without a timer or view once has no private note", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "plain", expiresInSeconds: 0 }))
    const [message] = await t.messages(ALICE)
    expect(message).not.toHaveProperty("private_note")
    expect(message).not.toHaveProperty("disappears_after_seconds")
  })
})
