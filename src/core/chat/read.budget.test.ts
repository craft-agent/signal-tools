import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { RESULT_BUDGET } from "../pages"
import {
  ALICE,
  BOB,
  GROUP_ID,
  ME,
  NUMBER,
  dataFrom,
  editFrom,
  groupDataFrom,
  reactionFrom,
  sentTo,
} from "../signal/mirror.testing"
import { ALICE_NUMBER, GROUP, createChatFixture, type ChatFixture } from "./read.testing"

const T = Date.UTC(2026, 10, 7, 5)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.contacts({ uuid: ALICE, name: "Alice", number: ALICE_NUMBER }, { uuid: ME, number: NUMBER })
})

afterEach(() => {
  t.close()
})

const size = (result: unknown) => JSON.stringify(result).length

describe("chat read: the size of a result", () => {
  test("many long messages come back as fewer items and a next, and the pages cover them all", async () => {
    const sent = Array.from({ length: 60 }, (_, n) => `m${n} ${"x".repeat(2000)}`)
    sent.forEach((message, n) => t.ingest(dataFrom(ALICE, T + n, { message })))
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const result = await t.read({ method: "view", chat: ALICE, ...(cursor ? { cursor } : {}) })
      expect(size(result)).toBeLessThan(RESULT_BUDGET)
      expect(result.messages?.length).toBeLessThan(50)
      seen.unshift(...(result.messages ?? []).map((message) => message.text ?? ""))
      cursor = result.next
      pages += 1
    } while (cursor)
    expect(pages).toBeGreaterThan(2)
    expect(seen).toEqual(sent)
  })

  test("text is never cut while the messages fit in a result, however long", async () => {
    const long = "y".repeat(10_000)
    t.ingest(dataFrom(ALICE, T, { message: long }), dataFrom(ALICE, T + 1, { message: "short" }))
    const messages = await t.messages(ALICE)
    expect(messages.map((message) => message.text)).toEqual([long, "short"])
    expect(messages.some((message) => "text_cut" in message)).toBe(false)
  })

  test("a message that alone exceeds the budget has its text cut to fit and says so", async () => {
    const long = `${'Ünï"\n🙂'.repeat(30_000)}`
    t.ingest(dataFrom(ALICE, T, { message: "older" }), dataFrom(ALICE, T + 1, { message: long }))
    const result = await t.read({ method: "view", chat: ALICE, limit: 1 })
    expect(result.messages).toHaveLength(1)
    const [message] = result.messages ?? []
    expect(message?.text_cut).toBe(true)
    expect(long.startsWith(message?.text ?? "x")).toBe(true)
    expect(message?.text?.length).toBeGreaterThan(1000)
    expect(LONE_SURROGATE.test(message?.text ?? "")).toBe(false)
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
    expect(result.next).toBeDefined()
    const older = await t.read({ method: "view", chat: ALICE, cursor: result.next })
    expect(older.messages?.map((entry) => entry.text)).toEqual(["older"])
  })

  test("an oversized message cuts its quote and captions only after its text", async () => {
    t.ingest(
      dataFrom(ALICE, T, {
        message: "z".repeat(10),
        quote: { id: T - 1, authorUuid: BOB, text: "q".repeat(60_000) },
        attachments: [{ id: "a", caption: "c".repeat(100) }],
      }),
    )
    const [message] = await t.messages(ALICE)
    expect(message?.text).toBe("z".repeat(10))
    expect(message?.files?.[0]?.caption).toBe("c".repeat(100))
    expect(message?.reply_to?.text?.length).toBeLessThan(60_000)
    expect(message?.text_cut).toBe(true)
  })

  test("a list with long last messages returns fewer chats and a next that continues", async () => {
    const people = Array.from({ length: 30 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`)
    people.forEach((person, n) => t.ingest(dataFrom(person, T + n, { message: "w".repeat(5000) })))
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const result = await t.read({ method: "list", last: true, limit: 200, ...(cursor ? { cursor } : {}) })
      expect(size(result)).toBeLessThan(RESULT_BUDGET)
      expect(result.chats?.length).toBeLessThan(30)
      seen.push(...(result.chats ?? []).map((chat) => chat.id))
      cursor = result.next
    } while (cursor)
    expect(seen).toEqual([...[...people].reverse(), ME])
  })

  test("a chat whose last message alone exceeds the budget is cut in the list", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "v".repeat(80_000) }))
    const result = await t.read({ method: "list", last: true })
    expect(result.chats?.[0]?.last_message?.text_cut).toBe(true)
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
  })

  const manyFiles = Array.from({ length: 3000 }, (_, n) => ({
    id: `stored-${n}`,
    contentType: "text/plain",
    filename: `${"n".repeat(100)}${n}.txt`,
    caption: "c",
  }))

  test("a message whose files alone exceed the budget drops its metadata, keeps its text and says what it left out", async () => {
    t.ingest(
      dataFrom(ALICE, T, { message: "hello", attachments: manyFiles }),
      editFrom(ALICE, T, T + 5, { message: "hello again", attachments: manyFiles }),
      reactionFrom(BOB, T, ALICE, "👍"),
    )
    const result = await t.read({ method: "view", chat: ALICE })
    const [message] = result.messages ?? []
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
    expect(message).toMatchObject({ text: "hello again", text_cut: true, files_omitted: 3000 })
    expect(message?.omitted).toEqual(["earlier_versions", "reactions", "files"])
    for (const field of ["files", "earlier_versions", "reactions"]) expect(message).not.toHaveProperty(field)
  })

  test("a metadata drop in a list keeps the chat and its other fields", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "hello", attachments: manyFiles }))
    const result = await t.read({ method: "list", last: true })
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
    expect(result.chats?.[0]?.last_message).toMatchObject({ text: "hello", files_omitted: 3000, omitted: ["files"] })
    expect(result.chats?.[0]).toMatchObject({ id: ALICE, name: "Alice", unread: 1 })
  })

  test("a huge group title is cut in a list and in a view, and says so", async () => {
    const title = `${"T".repeat(999)}😀${"t".repeat(60_000)}`
    t.groups({ id: GROUP_ID, name: title, members: [{ uuid: ALICE }], isMember: true })
    t.ingest(groupDataFrom(ALICE, T, { message: "hi" }))
    const list = await t.read({ method: "list", query: "ttt" })
    const view = await t.read({ method: "view", chat: GROUP })
    for (const named of [list.chats?.[0], view.chat]) {
      expect(named?.name).toBe("T".repeat(999))
      expect(named?.name_cut).toBe(true)
    }
    expect(size(list)).toBeLessThan(RESULT_BUDGET)
    expect(size(view)).toBeLessThan(RESULT_BUDGET)
    expect(LONE_SURROGATE.test(JSON.stringify([list, view]))).toBe(false)
    expect(view.messages?.[0]?.text).toBe("hi")
  })

  test("a name of 1,000 characters is not cut", async () => {
    t.groups({ id: GROUP_ID, name: "N".repeat(1000), members: [], isMember: true })
    t.ingest(groupDataFrom(ALICE, T, { message: "hi" }))
    const view = await t.read({ method: "view", chat: GROUP })
    expect(view.chat?.name).toBe("N".repeat(1000))
    expect(view.chat).not.toHaveProperty("name_cut")
  })
})

describe("chat read: a read changes nothing and shows nothing it must not", () => {
  test("leaves the mirror's mtime and size unchanged, with no WAL left behind", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "hi" }), sentTo(ALICE, T + 1, { message: "yo" }))
    t.closeMirror()
    const path = join(t.stateDir, "default", "mirror.sqlite")
    expect(existsSync(`${path}-wal`)).toBe(false)
    const before = statSync(path)
    await t.read({ method: "list", last: true, unread: true, query: "ali" })
    await t.read({ method: "view", chat: ALICE })
    const after = statSync(path)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(existsSync(`${path}-wal`)).toBe(false)
  })

  test("never carries the user's own number, an attachment id or a path", async () => {
    t.ingest(
      sentTo(ME, T, { message: "note", attachments: [{ id: "private-file-id", filename: "a.txt" }] }),
      dataFrom(ALICE, T + 1, { message: "hi", attachments: [{ id: "other-file-id", filename: "b.txt" }] }),
    )
    const json = JSON.stringify([
      await t.read({ method: "list", last: true }),
      await t.read({ method: "list", query: NUMBER }),
      await t.read({ method: "view", chat: ME }),
      await t.read({ method: "view", chat: ALICE }),
    ])
    expect(json).not.toContain(NUMBER)
    for (const hidden of ["private-file-id", "other-file-id", t.stateDir, "attachments"]) {
      expect(json).not.toContain(hidden)
    }
    expect(json).toContain(ALICE_NUMBER)
  })
})
