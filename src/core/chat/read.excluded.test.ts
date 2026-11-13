import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, ME, NOW, dataFrom } from "../signal/mirror.testing"
import { invoke } from "../tool"
import { excludingContext } from "./excluded.testing"
import { signalChatRead } from "./read"
import { GROUP, OTHER_GROUP, createChatFixture, fillSampleChats, type ChatFixture } from "./read.testing"
import type { ChatReadOutput } from "./schema"
import { searchMessages, type ScanLimits } from "./search"
import { withMirror } from "./open"

const T = Date.UTC(2026, 10, 7, 5)

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(() => {
  t.close()
})

/** Calls the tool with the `exclude_chats` setting holding `excluded`. */
const readWithout = (excluded: string[], args: Record<string, unknown>) =>
  invoke(signalChatRead, args, excludingContext(t.stateDir, excluded))

const listWithout = (excluded: string[], args: Record<string, unknown> = {}) =>
  readWithout(excluded, { method: "list", ...args })

const ids = (page: Pick<ChatReadOutput, "chats">) => page.chats?.map((chat) => chat.id)

describe("chat read: list leaves excluded chats out", () => {
  test("an excluded person or group is not listed, and a page is still full from the chats that remain", async () => {
    fillSampleChats(t)
    expect(ids(await listWithout([ALICE, GROUP]))).toEqual([ME, BOB, OTHER_GROUP])
    const first = await listWithout([ALICE], { limit: 2 })
    expect(ids(first)).toEqual([ME, BOB])
    expect(first.next).toBeDefined()
    const rest = await listWithout([ALICE], { limit: 2, cursor: first.next })
    expect(ids(rest)).toEqual([GROUP, OTHER_GROUP])
    expect(rest.next).toBeUndefined()
  })

  test("Note to Self is not listed when the own id is excluded, even before its first message", async () => {
    t.ingest(dataFrom(ALICE, 5000, { message: "hi" }))
    expect(ids(await t.read({ method: "list" }))).toEqual([ALICE, ME])
    expect(ids(await listWithout([ME]))).toEqual([ALICE])
  })

  test("the last message of a listed chat is shown, and none of an excluded chat", async () => {
    fillSampleChats(t)
    const page = await listWithout([ALICE], { last: true })
    expect(page.chats?.[1]).toMatchObject({ id: BOB, last_message: { text: "hello from Bob" } })
    expect(JSON.stringify(page)).not.toContain("hello from Alice")
  })

  test("unread messages of an excluded chat are not counted or listed", async () => {
    fillSampleChats(t)
    expect(ids(await t.read({ method: "list", unread: true }))).toContain(ALICE)
    const page = await listWithout([ALICE], { unread: true })
    expect(ids(page)).toEqual([BOB, GROUP])
    expect(page.chats?.map((chat) => chat.unread)).toEqual([1, 1])
  })

  test("with no chat excluded the list is as it was", async () => {
    fillSampleChats(t)
    expect(ids(await listWithout([]))).toEqual(ids(await t.read({ method: "list" })))
  })

  test("a cursor taken without the setting is refused with it, and one taken with it without", async () => {
    fillSampleChats(t)
    const open = await t.read({ method: "list", limit: 1 })
    await expect(listWithout([GROUP], { limit: 1, cursor: open.next })).rejects.toMatchObject({
      code: "invalid_argument",
    })
    const closed = await listWithout([GROUP], { limit: 1 })
    await expect(t.read({ method: "list", limit: 1, cursor: closed.next })).rejects.toMatchObject({
      code: "invalid_argument",
    })
    await expect(listWithout([BOB], { limit: 1, cursor: closed.next })).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })

  test("the order the setting lists its chats in does not change its cursors", async () => {
    fillSampleChats(t)
    const first = await listWithout([GROUP, BOB], { limit: 1 })
    expect(ids(await listWithout([BOB, GROUP], { limit: 1, cursor: first.next }))).toEqual([ME])
  })
})

/** Calls the search itself, with the scan limits of the test's own. */
function search(excluded: string[], args: Record<string, unknown>, scan?: ScanLimits) {
  return withMirror({ stateDir: t.stateDir }, undefined, (mirror, me) =>
    searchMessages(mirror, me, { query: "needle", ...args }, Date.now(), new Set(excluded), scan),
  )
}

const texts = (page: Pick<ChatReadOutput, "messages">) => page.messages?.map((message) => message.text)

describe("chat read: search leaves excluded chats out", () => {
  test("a search across chats returns no message of an excluded chat", async () => {
    t.contacts({ uuid: BOB, name: "Bob Example" })
    t.ingest(dataFrom(ALICE, T, { message: "needle alice" }), dataFrom(BOB, T + 1, { message: "needle bob" }))
    const page = await readWithout([BOB], { method: "search", query: "needle" })
    expect(texts(page)).toEqual(["needle alice"])
    expect(JSON.stringify(page)).not.toContain("Bob Example")
  })

  test("excluded messages take no part of the scan, and no place in a page or a cursor", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "needle alice" }))
    const insert = t.mirror.prepare(
      "INSERT INTO messages (chat, author, ts, from_me, kind, body, expires_in, received) VALUES (?, ?, ?, 0, 'message', 'needle bob', 0, ?)",
    )
    t.mirror.exec("BEGIN")
    for (let n = 0; n < 12; n += 1) insert.run(BOB, BOB, T + 1 + n, NOW)
    t.mirror.exec("COMMIT")
    const scan = { chunk: 3, maxScanned: 3 }
    expect((await search([], {}, scan)).scanned_to).toBeDefined()
    const page = await search([BOB], {}, scan)
    expect(texts(page)).toEqual(["needle alice"])
    expect(page.scanned_to).toBeUndefined()
    expect(page.next).toBeUndefined()
    const full = await search([BOB], { limit: 1 }, scan)
    expect(texts(full)).toEqual(["needle alice"])
    expect(full.next).toBeUndefined()
  })

  test("a cursor taken without the setting is refused with it, and one taken with it without", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "needle alice" }), dataFrom(ALICE, T + 1, { message: "needle again" }))
    const open = await search([], { limit: 1 })
    expect(open.next).toBeDefined()
    await expect(search([BOB], { limit: 1, cursor: open.next })).rejects.toThrow("cursor is not a cursor")
    const closed = await search([BOB], { limit: 1 })
    expect(closed.next).toBeDefined()
    await expect(search([], { limit: 1, cursor: closed.next })).rejects.toThrow("cursor is not a cursor")
    expect(texts(await search([BOB], { limit: 1, cursor: closed.next }))).toEqual(["needle alice"])
  })

  test("the order of the setting does not change a search cursor", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "needle alice" }), dataFrom(ALICE, T + 1, { message: "needle again" }))
    const first = await search([BOB, GROUP], { limit: 1 })
    expect(texts(await search([GROUP, BOB], { limit: 1, cursor: first.next }))).toEqual(["needle alice"])
  })
})
