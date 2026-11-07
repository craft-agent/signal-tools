import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, ME, dataFrom, sentTo } from "../signal/mirror.testing"
import { formatLocalTime } from "../time"
import { GROUP, OTHER_GROUP, createChatFixture, fillSampleChats, type ChatFixture } from "./read.testing"
import type { ChatEntry } from "./schema"

/** The user's own chat before its first message: the mirror knows the account id and has no row for it. */
const NOTE_TO_SELF: ChatEntry = { id: ME, kind: "person", name: "Note to Self", unread: 0 }

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(() => {
  t.close()
})

async function ids(args: Record<string, unknown> = {}) {
  return (await t.read({ method: "list", ...args })).chats?.map((chat) => chat.id)
}

describe("chat read: Note to Self before its first message", () => {
  test("is listed on a mirror with no chat at all, with no activity", async () => {
    expect((await t.read({ method: "list" })).chats).toEqual([NOTE_TO_SELF])
    expect(t.mirror.prepare("SELECT COUNT(*) AS n FROM chats").get()).toEqual({ n: 0 })
  })

  test("comes after the chats with activity, and by id among the groups without a message", async () => {
    fillSampleChats(t)
    t.mirror.prepare("DELETE FROM messages WHERE chat = ?").run(ME)
    t.mirror.prepare("DELETE FROM chats WHERE id = ?").run(ME)
    expect(await ids()).toEqual([ALICE, BOB, GROUP, ME, OTHER_GROUP])
  })

  test("is never listed twice once it has a row", async () => {
    t.ingest(sentTo(ME, 4000, { message: "remember" }))
    const result = await t.read({ method: "list" })
    expect(result.chats).toEqual([{ ...NOTE_TO_SELF, last_activity_at: formatLocalTime(4000) }])
  })

  test("is not listed when the mirror does not know the account id", async () => {
    t.mirror.prepare("DELETE FROM meta").run()
    t.ingest(dataFrom(ALICE, 5000, { message: "hi" }))
    expect(await ids()).toEqual([ALICE])
  })

  test("has a null last message when asked for", async () => {
    const result = await t.read({ method: "list", last: true })
    expect(result.chats).toEqual([{ ...NOTE_TO_SELF, last_message: null }])
  })

  test("answers a query for its name, and not one for another", async () => {
    expect(await ids({ query: "note to" })).toEqual([ME])
    expect(await ids({ query: "alice" })).toEqual([])
  })

  test("has no unread messages, so the unread filter leaves it out", async () => {
    t.ingest(dataFrom(ALICE, 5000, { message: "hi" }))
    expect(await ids({ unread: true })).toEqual([ALICE])
    expect(await ids({ unread: false })).toEqual([ALICE, ME])
  })

  test("pages like any chat: the page before it continues with it, once", async () => {
    t.ingest(dataFrom(ALICE, 5000, { message: "a" }), dataFrom(BOB, 3000, { message: "b" }))
    const first = await t.read({ method: "list", limit: 2 })
    expect(first.chats?.map((chat) => chat.id)).toEqual([ALICE, BOB])
    const second = await t.read({ method: "list", limit: 2, cursor: first.next })
    expect(second.chats).toEqual([NOTE_TO_SELF])
    expect(second.next).toBeUndefined()
  })

  test("a page that ends with it does not continue, and one that ends before it does", async () => {
    t.ingest(dataFrom(ALICE, 5000, { message: "a" }))
    const exact = await t.read({ method: "list", limit: 2 })
    expect(exact.chats?.map((chat) => chat.id)).toEqual([ALICE, ME])
    expect(exact.next).toBeUndefined()
    const short = await t.read({ method: "list", limit: 1 })
    expect(short.next).toBeDefined()
  })
})

describe("chat read: Note to Self as a chat to read before its first message", () => {
  test("view is an empty page with the chat named", async () => {
    const result = await t.read({ method: "view", chat: ME })
    expect(result.chat).toEqual({ id: ME, kind: "person", name: "Note to Self" })
    expect(result.messages).toEqual([])
    expect(result.next).toBeUndefined()
  })

  test("search in it finds nothing, without failing", async () => {
    t.ingest(dataFrom(ALICE, 5000, { message: "remember this" }))
    expect((await t.read({ method: "search", query: "remember", chat: ME })).messages).toEqual([])
  })

  test("around is not_found for a message, as in any chat, not for the chat", async () => {
    const error = await t.failure({ method: "around", chat: ME, id: `${ME}:1000` })
    expect([error.code, error.message]).toEqual(["not_found", "No message with this id in this chat."])
  })

  test("another account id with no row is still an unknown chat", async () => {
    const error = await t.failure({ method: "view", chat: ALICE })
    expect([error.code, error.message]).toEqual(["not_found", "No chat with this id in this account's mirror."])
  })

  test("with no account id known, its id is an unknown chat", async () => {
    t.mirror.prepare("DELETE FROM meta").run()
    expect((await t.failure({ method: "view", chat: ME })).code).toBe("not_found")
  })
})
