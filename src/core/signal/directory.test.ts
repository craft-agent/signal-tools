import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { recordSent, rememberNumber, upsertContacts, upsertGroups } from "./directory"
import {
  ALICE,
  BOB,
  GROUP_ID,
  ME,
  NOW,
  NUMBER,
  OTHER_GROUP_ID,
  columnOf,
  createTestMirror,
  dataFrom,
  groupDataFrom,
  messageRow,
  rowsOf,
  type TestMirror,
} from "./mirror.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => {
  t.close()
})

function contactRows(): unknown[] {
  return rowsOf(
    t.mirror,
    "SELECT uuid, number, name, profile_name, username, blocked, updated FROM contacts ORDER BY uuid",
  )
}

describe("upsertContacts", () => {
  test("stores a contact with its nickname first, then its card name, then any other name", () => {
    const count = upsertContacts(
      t.mirror,
      [
        {
          uuid: ALICE,
          number: NUMBER,
          nickGivenName: "Al",
          nickFamilyName: "Nick",
          givenName: "Alice",
          familyName: "Card",
          name: "x",
        },
        { uuid: BOB, givenName: "Bob", familyName: "Card", nickName: "y" },
        { uuid: ME, nickName: "Me", name: "z" },
      ],
      NOW,
    )
    expect(count).toBe(3)
    expect(columnOf(t.mirror, "SELECT name FROM contacts ORDER BY uuid")).toEqual(["Me", "Al Nick", "Bob Card"])
  })

  test("keeps the profile name, number and username, and the blocked mark", () => {
    upsertContacts(
      t.mirror,
      [
        {
          uuid: ALICE.toUpperCase(),
          number: NUMBER,
          username: "alice.01",
          isBlocked: true,
          profile: { givenName: "Al", familyName: "P" },
        },
      ],
      NOW,
    )
    expect(contactRows()).toEqual([
      { uuid: ALICE, number: NUMBER, name: null, profile_name: "Al P", username: "alice.01", blocked: 1, updated: NOW },
    ])
  })

  test("a later listing without a number or profile keeps what the mirror learned, and replaces the rest", () => {
    upsertContacts(
      t.mirror,
      [{ uuid: ALICE, number: NUMBER, name: "Old", isBlocked: true, profile: { givenName: "Al" } }],
      NOW,
    )
    upsertContacts(t.mirror, [{ uuid: ALICE, name: "New" }], NOW + 1)
    expect(contactRows()).toEqual([
      { uuid: ALICE, number: NUMBER, name: "New", profile_name: "Al", username: null, blocked: 0, updated: NOW + 1 },
    ])
  })

  test("sets the timer of the person's chat when it is known", () => {
    t.ingest(dataFrom(ALICE, 1000, { message: "hi" }))
    upsertContacts(
      t.mirror,
      [
        { uuid: ALICE, messageExpirationTime: 3600 },
        { uuid: BOB, messageExpirationTime: 60 },
      ],
      NOW,
    )
    expect(rowsOf(t.mirror, "SELECT id, expires_in FROM chats")).toEqual([{ id: ALICE, expires_in: 3600 }])
  })

  test("skips what has no account id, and anything but a list", () => {
    expect(upsertContacts(t.mirror, [{ number: NUMBER }, null, "x", { uuid: "not-a-uuid" }, { uuid: BOB }], NOW)).toBe(
      1,
    )
    expect(columnOf(t.mirror, "SELECT uuid FROM contacts")).toEqual([BOB])
    for (const bad of [undefined, null, {}, "x", 3]) expect(upsertContacts(t.mirror, bad, NOW)).toBe(0)
  })
})

describe("upsertGroups", () => {
  test("stores a group's name, members and timer, and keeps its latest message time", () => {
    t.ingest(groupDataFrom(ALICE, 1000, { message: "hi" }))
    const count = upsertGroups(
      t.mirror,
      [
        {
          id: GROUP_ID,
          name: "Team",
          messageExpirationTime: 600,
          members: [{ uuid: ALICE.toUpperCase() }, { number: NUMBER }, { uuid: BOB }, null],
        },
      ],
      NOW + 1,
    )
    expect(count).toBe(1)
    const [row] = rowsOf(t.mirror, "SELECT id, kind, name, members, member, expires_in, last_ts, updated FROM chats")
    expect(row).toEqual({
      id: `group:${GROUP_ID}`,
      kind: "group",
      name: "Team",
      members: JSON.stringify([ALICE, BOB]),
      member: 1,
      expires_in: 600,
      last_ts: 1000,
      updated: NOW + 1,
    })
  })

  test("marks a group the account has left, and drops a group's removed timer", () => {
    upsertGroups(t.mirror, [{ id: GROUP_ID, name: "Team", messageExpirationTime: 600, members: [] }], NOW)
    upsertGroups(t.mirror, [{ id: GROUP_ID, isMember: false }], NOW + 1)
    expect(rowsOf(t.mirror, "SELECT name, member, expires_in, members FROM chats")).toEqual([
      { name: null, member: 0, expires_in: null, members: "[]" },
    ])
  })

  test("skips a malformed id, and anything but a list", () => {
    const groups = [{ id: "short" }, { id: 7 }, null, { id: OTHER_GROUP_ID, name: "Ok" }]
    expect(upsertGroups(t.mirror, groups, NOW)).toBe(1)
    expect(columnOf(t.mirror, "SELECT id FROM chats")).toEqual([`group:${OTHER_GROUP_ID}`])
    for (const bad of [undefined, null, {}, "x"]) expect(upsertGroups(t.mirror, bad, NOW)).toBe(0)
  })
})

describe("rememberNumber", () => {
  test("remembers a number for an account, and a fresher one replaces it", () => {
    rememberNumber(t.mirror, NUMBER, ALICE, NOW)
    rememberNumber(t.mirror, "+15555550199", ALICE, NOW + 1)
    expect(contactRows()).toEqual([
      {
        uuid: ALICE,
        number: "+15555550199",
        name: null,
        profile_name: null,
        username: null,
        blocked: 0,
        updated: NOW + 1,
      },
    ])
  })

  test("takes the number from another account that had it", () => {
    rememberNumber(t.mirror, NUMBER, ALICE, NOW)
    rememberNumber(t.mirror, NUMBER, BOB, NOW + 1)
    expect(columnOf(t.mirror, "SELECT uuid FROM contacts WHERE number = ?", NUMBER)).toEqual([BOB])
    expect(columnOf(t.mirror, "SELECT uuid FROM contacts")).toEqual([ALICE, BOB])
  })

  test("keeps what else a contact has, and ignores what is not an account id or a number", () => {
    upsertContacts(t.mirror, [{ uuid: ALICE, name: "Alice" }], NOW)
    rememberNumber(t.mirror, NUMBER, ALICE.toUpperCase(), NOW + 1)
    rememberNumber(t.mirror, NUMBER, "not-a-uuid", NOW + 2)
    rememberNumber(t.mirror, "", BOB, NOW + 2)
    expect(rowsOf(t.mirror, "SELECT uuid, number, name FROM contacts")).toEqual([
      { uuid: ALICE, number: NUMBER, name: "Alice" },
    ])
  })
})

describe("recordSent", () => {
  const sent = { me: ME, body: "from the tools", attachments: [], quote: null, now: NOW }

  test("records a message the account sent, in a new chat", () => {
    recordSent(t.mirror, { ...sent, chat: ALICE, ts: 1000 })
    expect(messageRow(t.mirror, ME, 1000)).toMatchObject({
      chat: ALICE,
      from_me: 1,
      body: "from the tools",
      attachments: null,
      quote: null,
      expires_in: 0,
      expire_start: null,
      received: NOW,
    })
    expect(rowsOf(t.mirror, "SELECT id, kind, last_ts, updated FROM chats")).toEqual([
      { id: ALICE, kind: "person", last_ts: 1000, updated: NOW },
    ])
  })

  test("records a send to a group with its files and the message it quotes", () => {
    const chat = `group:${GROUP_ID}`
    const quote = { id: 900, author: BOB, text: "q" }
    recordSent(t.mirror, {
      ...sent,
      chat,
      ts: 2000,
      body: null,
      attachments: [{ id: "a.png", type: "image/png" }],
      quote,
    })
    const row = messageRow(t.mirror, ME, 2000)
    expect(row).toMatchObject({ chat, body: null })
    expect(JSON.parse(row?.attachments as string)).toEqual([{ id: "a.png", type: "image/png" }])
    expect(JSON.parse(row?.quote as string)).toEqual(quote)
    expect(columnOf(t.mirror, "SELECT kind FROM chats")).toEqual(["group"])
  })

  test("takes the chat's disappearing timer, which starts when the message is sent", () => {
    t.ingest(dataFrom(ALICE, 1000, { isExpirationUpdate: true, expiresInSeconds: 3600 }))
    recordSent(t.mirror, { ...sent, chat: ALICE, ts: 2000 })
    expect(messageRow(t.mirror, ME, 2000)).toMatchObject({ expires_in: 3600, expire_start: 2000 })
  })

  test("recording the same send twice keeps one message", () => {
    recordSent(t.mirror, { ...sent, chat: ALICE, ts: 1000 })
    recordSent(t.mirror, { ...sent, chat: ALICE, ts: 1000, body: "again" })
    expect(columnOf(t.mirror, "SELECT body FROM messages")).toEqual(["from the tools"])
  })
})
