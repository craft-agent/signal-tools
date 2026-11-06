import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, ME, dataFrom } from "../signal/mirror.testing"
import { CAROL, GROUP, OTHER_GROUP, createChatFixture, fillSampleChats, type ChatFixture } from "./read.testing"

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

describe("chat read: list query", () => {
  test("matches part of a name or number, ignoring case", async () => {
    fillSampleChats(t)
    expect(await ids({ query: "ali" })).toEqual([ALICE])
    expect(await ids({ query: "  ALICE " })).toEqual([ALICE])
    expect(await ids({ query: "team" })).toEqual([GROUP])
    expect(await ids({ query: "bob" })).toEqual([BOB])
    expect(await ids({ query: "nobody" })).toEqual([])
  })

  test("matches a number however it is typed", async () => {
    fillSampleChats(t)
    expect(await ids({ query: "555 0177" })).toEqual([ALICE])
    expect(await ids({ query: "+1 (555) 555-0188" })).toEqual([BOB])
    expect(await ids({ query: "+1.555.555.0177" })).toEqual([ALICE])
    expect(await ids({ query: "555 0199" })).toEqual([])
  })

  test("a query of blank space filters nothing", async () => {
    fillSampleChats(t)
    expect(await ids({ query: "   " })).toEqual(await ids())
  })

  test("folds non-ASCII case, and an accent written either way", async () => {
    t.contacts({ uuid: ALICE, name: "Ärger Östlich" }, { uuid: BOB, name: "Zoë" })
    t.ingest(dataFrom(ALICE, 2000, { message: "a" }), dataFrom(BOB, 1000, { message: "b" }))
    for (const query of ["ä", "Ä", "ärger", "ÄRGER", "östl", "ÖSTL"]) expect(await ids({ query })).toEqual([ALICE])
    for (const query of ["zoë", "ZOË", "zoe\u0308", "ZOE\u0308"]) expect(await ids({ query })).toEqual([BOB])
  })

  test("ß meets ss, a final ς meets σ, and compatibility forms meet their plain letters", async () => {
    t.contacts({ uuid: ALICE, name: "Straße" }, { uuid: BOB, name: "ΟΔΟΣ" }, { uuid: CAROL, name: "ﬁsh ＡＢＣ" })
    t.ingest(
      dataFrom(ALICE, 3000, { message: "a" }),
      dataFrom(BOB, 2000, { message: "b" }),
      dataFrom(CAROL, 1000, { message: "c" }),
    )
    for (const query of ["strasse", "STRASSE", "straße", "ß", "ss"]) expect(await ids({ query })).toEqual([ALICE])
    for (const query of ["οδος", "οδοσ", "ΟΔΟΣ", "Οδος", "δοσ"]) expect(await ids({ query })).toEqual([BOB])
    for (const query of ["fish", "FISH", "abc", "ＡＢＣ"]) expect(await ids({ query })).toEqual([CAROL])
  })

  test("combines with unread, and pages with the filter applied", async () => {
    fillSampleChats(t)
    expect(await ids({ query: "hello", unread: true })).toEqual([])
    expect(await ids({ query: "a", unread: true })).toEqual([ALICE, GROUP])
    const first = await t.read({ method: "list", query: "e", limit: 1 })
    expect(first.chats?.map((chat) => chat.id)).toEqual([ALICE])
    const second = await t.read({ method: "list", query: "e", limit: 5, cursor: first.next })
    expect(second.chats?.map((chat) => chat.id)).toEqual([ME, GROUP, OTHER_GROUP])
  })

  test("a cursor continues the list it came from, and is refused for a different query or unread", async () => {
    fillSampleChats(t)
    const plain = await t.read({ method: "list", limit: 1 })
    const queried = await t.read({ method: "list", limit: 1, query: "e" })
    const unread = await t.read({ method: "list", limit: 1, unread: true })
    const refused = [
      { query: "e", cursor: plain.next },
      { cursor: queried.next },
      { query: "a", cursor: queried.next },
      { unread: true, cursor: plain.next },
      { cursor: unread.next },
      { unread: true, query: "e", cursor: queried.next },
    ]
    for (const args of refused) {
      const error = await t.failure({ method: "list", ...args })
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toBe("cursor is not a cursor this tool returned.")
    }
    const accepted = [
      { query: "E ", cursor: queried.next },
      { unread: false, cursor: plain.next },
      { last: true, cursor: plain.next },
      { unread: true, cursor: unread.next },
    ]
    for (const args of accepted) expect((await t.read({ method: "list", ...args })).chats).toBeDefined()
  })

  test("the cursor stays short however long the query", async () => {
    const long = "q".repeat(3000)
    t.contacts({ uuid: ALICE, name: `${long}a` }, { uuid: BOB, name: `${long}b` })
    t.ingest(dataFrom(ALICE, 2000, { message: "a" }), dataFrom(BOB, 1000, { message: "b" }))
    const first = await t.read({ method: "list", limit: 1, query: long })
    expect(first.chats?.[0]).toMatchObject({ id: ALICE, name_cut: true })
    expect(first.next?.length).toBeLessThan(200)
    const second = await t.read({ method: "list", limit: 1, query: long, cursor: first.next })
    expect(second.chats?.map((chat) => chat.id)).toEqual([BOB])
  })
})
