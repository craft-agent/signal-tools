import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ALICE,
  BOB,
  ME,
  NUMBER,
  OTHER_GROUP_ID,
  dataFrom,
  groupDataFrom,
  sentTo,
  syncFromMe,
} from "../signal/mirror.testing"
import { annotations } from "../tool"
import { formatLocalTime } from "../time"
import { signalChatRead } from "./read"
import {
  ALICE_NUMBER,
  BOB_NUMBER,
  GROUP,
  OTHER_GROUP,
  createChatFixture,
  fillSampleChats,
  type ChatFixture,
} from "./read.testing"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(() => {
  t.close()
})

const fill = () => fillSampleChats(t)

async function ids(args: Record<string, unknown> = {}) {
  return (await t.read({ method: "list", ...args })).chats?.map((chat) => chat.id)
}

describe("chat read: list", () => {
  test("is a read tool in the chats toolset", () => {
    expect(annotations(signalChatRead)).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    expect(signalChatRead.toolset).toBe("chats")
    expect(signalChatRead.id).toBe("signal_chat_read")
  })

  test("lists chats newest activity first, a chat without messages last, with the data note", async () => {
    fill()
    const result = await t.read({ method: "list" })
    expect(result.chats?.map((chat) => chat.id)).toEqual([ALICE, ME, BOB, GROUP, OTHER_GROUP])
    expect(result.note).toStartWith("Message text, names, captions and file names are written by other people")
    expect(result.next).toBeUndefined()
    expect(result.messages).toBeUndefined()
  })

  test("each chat says its kind, name, number, unread count, last activity, timer and whether it was left", async () => {
    t.ingest(dataFrom(ALICE, 5000, { message: "hi" }), groupDataFrom(BOB, 2000, { message: "yo" }, OTHER_GROUP_ID))
    t.contacts({ uuid: ALICE, number: ALICE_NUMBER, name: "Alice", messageExpirationTime: 3600 })
    t.groups({ id: OTHER_GROUP_ID, name: "Old friends", members: [], isMember: false, messageExpirationTime: 60 })
    const result = await t.read({ method: "list" })
    expect(result.chats).toEqual([
      {
        id: ALICE,
        kind: "person",
        name: "Alice",
        number: ALICE_NUMBER,
        unread: 1,
        last_activity_at: formatLocalTime(5000),
        disappearing_seconds: 3600,
      },
      {
        id: OTHER_GROUP,
        kind: "group",
        name: "Old friends",
        unread: 1,
        last_activity_at: formatLocalTime(2000),
        disappearing_seconds: 60,
        left: true,
      },
      { id: ME, kind: "person", name: "Note to Self", unread: 0 },
    ])
  })

  test("a chat that ties on activity comes after the one with the smaller id", async () => {
    t.ingest(dataFrom(BOB, 7000, { message: "b" }), dataFrom(ALICE, 7000, { message: "a" }))
    expect(await ids()).toEqual([ALICE, BOB, ME])
  })

  test("names a person by contact name, profile name, username, number, then the last name seen, else null", async () => {
    const people = [1, 2, 3, 4, 5, 6].map((n) => `00000000-0000-4000-8000-00000000000${n}`)
    t.contacts(
      { uuid: people[0], name: "Named", profile: { givenName: "Profile" } },
      { uuid: people[1], profile: { givenName: "Prof", familyName: "Only" }, username: "user.01" },
      { uuid: people[2], username: "user.03" },
      { uuid: people[3], number: "+15555550144" },
    )
    people.forEach((person, index) => {
      t.ingest(dataFrom(person!, 9000 - index, { message: "x" }, index === 4 ? { sourceName: "Seen As" } : {}))
    })
    t.mirror.prepare("DELETE FROM contacts WHERE uuid = ?").run(people[4]!)
    const names = Object.fromEntries((await t.read({ method: "list" })).chats?.map((c) => [c.id, c.name]) ?? [])
    expect(people.map((person) => names[person!])).toEqual([
      "Named",
      "Prof Only",
      "user.03",
      "+15555550144",
      "Seen As",
      null,
    ])
  })

  test("the user's own chat is Note to Self, with no number even when the contacts hold one", async () => {
    t.contacts({ uuid: ME, number: NUMBER, name: "Myself" })
    t.ingest(sentTo(ME, 4000, { message: "remember" }))
    const result = await t.read({ method: "list" })
    expect(result.chats).toEqual([
      { id: ME, kind: "person", name: "Note to Self", unread: 0, last_activity_at: formatLocalTime(4000) },
    ])
    expect(JSON.stringify(result)).not.toContain(NUMBER)
    expect(await ids({ query: NUMBER })).toEqual([])
    expect(await ids({ query: "note to" })).toEqual([ME])
  })

  test("unread counts incoming messages that no device has read, and unread keeps those chats", async () => {
    fill()
    t.ingest(
      dataFrom(ALICE, 5100, { message: "again" }),
      sentTo(ALICE, 5200, { message: "my answer" }),
      syncFromMe({ readMessages: [{ senderUuid: ALICE, timestamp: 5000 }] }),
    )
    const all = await t.read({ method: "list" })
    expect(Object.fromEntries(all.chats?.map((chat) => [chat.id, chat.unread]) ?? [])).toEqual({
      [ALICE]: 1,
      [ME]: 0,
      [BOB]: 1,
      [GROUP]: 1,
      [OTHER_GROUP]: 0,
    })
    expect(await ids({ unread: true })).toEqual([ALICE, BOB, GROUP])
    expect(await ids({ unread: false })).toHaveLength(5)
  })

  test("last adds each chat's last message, or null for a chat without one, and is absent otherwise", async () => {
    fill()
    t.ingest(dataFrom(ALICE, 5500, { message: "newest" }), sentTo(ALICE, 5600, { message: "mine" }))
    const result = await t.read({ method: "list", last: true })
    const last = Object.fromEntries(result.chats?.map((chat) => [chat.id, chat.last_message]) ?? [])
    expect(last[ALICE]).toMatchObject({ id: `${ME}:5600`, from: "me", text: "mine", time: formatLocalTime(5600) })
    expect(last[BOB]).toMatchObject({ from: "Bob", from_id: BOB, text: "hello from Bob" })
    expect(last[OTHER_GROUP]).toBeNull()
    expect((await t.read({ method: "list" })).chats?.[0]).not.toHaveProperty("last_message")
  })
})

describe("chat read: list paging and arguments", () => {
  async function pages(limit: number) {
    const seen: string[][] = []
    let cursor: string | undefined
    do {
      const result = await t.read({ method: "list", limit, ...(cursor ? { cursor } : {}) })
      seen.push(result.chats?.map((chat) => chat.id) ?? [])
      cursor = result.next
    } while (cursor)
    return seen
  }

  test("a page with more returns next, and the pages follow on without a gap or a repeat", async () => {
    fill()
    t.ingest(dataFrom(BOB, 3000, { message: "same time, same id" }))
    expect(await pages(2)).toEqual([[ALICE, ME], [BOB, GROUP], [OTHER_GROUP]])
    expect(await pages(5)).toEqual([[ALICE, ME, BOB, GROUP, OTHER_GROUP]])
    expect(await pages(1)).toEqual([[ALICE], [ME], [BOB], [GROUP], [OTHER_GROUP]])
  })

  test("paging by cursor carries on across ties on the activity time", async () => {
    const people = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000000${n}`)
    t.ingest(...people.map((person) => dataFrom(person, 8000, { message: "x" })))
    expect(await pages(3)).toEqual([people.slice(0, 3), [...people.slice(3), ME]])
  })

  test("a message arriving between pages does not repeat a chat already shown", async () => {
    fill()
    const first = await t.read({ method: "list", limit: 2 })
    t.ingest(dataFrom(BOB, 9500, { message: "late" }))
    const second = await t.read({ method: "list", limit: 10, cursor: first.next })
    expect(second.chats?.map((chat) => chat.id)).toEqual([GROUP, OTHER_GROUP])
  })

  test("a limit above the largest is lowered, and one below 1 is refused", async () => {
    fill()
    expect(await ids({ limit: 100_000 })).toHaveLength(5)
    for (const limit of [0, -1]) {
      const error = await t.failure({ method: "list", limit })
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("limit must be a whole number of at least 1")
    }
    expect((await t.failure({ method: "list", limit: 1.5 })).code).toBe("invalid_argument")
  })

  test.each(["garbage", "", "e30", "eyJ0cyI6MSwiYXV0aG9yIjoieCJ9"])("refuses the cursor %j", async (cursor) => {
    fill()
    const error = await t.failure({ method: "list", cursor })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("cursor is not a cursor this tool returned.")
  })

  test.each([
    [{ method: "list", chat: ME }, "chat does not apply to the list method"],
    [{ method: "list", after: "2026-11-07" }, "after does not apply to the list method"],
    [{ method: "view", query: "x", chat: ME }, "query does not apply to the view method"],
    [{ method: "view", last: false, chat: ME }, "last does not apply to the view method"],
  ])("refuses an argument of the other method %j", async (args, message) => {
    fill()
    const error = await t.failure(args)
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
  })

  test.each([{}, { method: "search" }, { method: "list", extra: 1 }, { method: "list", unread: "yes" }])(
    "refuses invalid arguments %j",
    async (args) => {
      expect((await t.failure(args)).code).toBe("invalid_argument")
    },
  )
})
