import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ALICE,
  BOB,
  GROUP_ID,
  ME,
  NUMBER,
  OTHER_GROUP_ID,
  dataFrom,
  editFrom,
  reactionFrom,
} from "../signal/mirror.testing"
import { invoke } from "../tool"
import { excludingContext } from "./excluded.testing"
import { signalChatRead } from "./read"
import { BOB_NUMBER, CAROL, GROUP, OTHER_GROUP, createChatFixture, type ChatFixture } from "./read.testing"

const PLACEHOLDER = "\uFFFC"
const T = Date.UTC(2026, 10, 7, 5)
const BOB_CONTACT_NAME = "Bob Contact"
const BOB_STORED_NAME = "Bobby Stored"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.contacts({ uuid: ALICE, name: "Alice" }, { uuid: BOB, name: BOB_CONTACT_NAME, number: BOB_NUMBER })
  t.groups(
    { id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: BOB }], isMember: true },
    { id: OTHER_GROUP_ID, name: "Closed", members: [{ uuid: CAROL }], isMember: true },
  )
})

afterEach(() => {
  t.close()
})

/** A message to a group from `source`, which Signal sent with its profile name `sourceName` when given. */
function inGroup(
  source: string,
  sent: number,
  message: Record<string, unknown>,
  sourceName?: string,
  groupId = GROUP_ID,
) {
  const groupInfo = { groupId, type: "DELIVER" }
  return dataFrom(source, sent, { groupInfo, ...message }, sourceName === undefined ? {} : { sourceName })
}

/** The messages of the group as `view` returns them, with the chats of `excluded` left out of every tool. */
async function groupWithout(excluded: string[]) {
  const page = await invoke(signalChatRead, { method: "view", chat: GROUP }, excludingContext(t.stateDir, excluded))
  return page.messages ?? []
}

describe("chat read: a person whose private chat is excluded, in an allowed group", () => {
  test("is shown by the name their message stored, never by the contact's name or number", async () => {
    t.ingest(inGroup(BOB, T, { message: "hi" }, BOB_STORED_NAME))
    const [open] = await groupWithout([])
    expect(open).toMatchObject({ from: BOB_CONTACT_NAME, from_id: BOB })
    const [message, ...rest] = await groupWithout([BOB])
    expect(rest).toEqual([])
    expect(message).toMatchObject({ from: BOB_STORED_NAME, from_id: BOB, text: "hi" })
    expect(JSON.stringify(message)).not.toContain(BOB_CONTACT_NAME)
    expect(JSON.stringify(message)).not.toContain(BOB_NUMBER)
  })

  test("is shown by the account id when their message stored no name", async () => {
    t.ingest(inGroup(BOB, T, { message: "hi" }))
    const [message] = await groupWithout([BOB])
    expect(message).toMatchObject({ from: BOB, from_id: BOB })
  })

  test("is written @id where an allowed message mentions them, in the message and in its quote", async () => {
    t.ingest(
      inGroup(ALICE, T, {
        message: `hey ${PLACEHOLDER}`,
        mentions: [{ uuid: BOB, number: BOB_NUMBER, start: 4, length: 1 }],
        quote: {
          id: T - 9,
          authorUuid: BOB,
          text: `ask ${PLACEHOLDER}`,
          mentions: [{ uuid: BOB, number: BOB_NUMBER, start: 4, length: 1 }],
        },
      }),
    )
    const [open] = await groupWithout([])
    expect(open?.text).toBe(`hey @${BOB_CONTACT_NAME}`)
    const [message] = await groupWithout([BOB])
    expect(message?.text).toBe(`hey @${BOB}`)
    expect(message?.reply_to).toEqual({ id: `${BOB}:${T - 9}`, text: `ask @${BOB}` })
    expect(JSON.stringify(message)).not.toContain(BOB_CONTACT_NAME)
    expect(JSON.stringify(message)).not.toContain(BOB_NUMBER)
  })

  test("keeps their reaction to an allowed message, by id", async () => {
    t.ingest(inGroup(ALICE, T, { message: "react to me" }), reactionFrom(BOB, T, ALICE, "👍"))
    const [open] = await groupWithout([])
    expect(open?.reactions).toEqual([{ from: BOB_CONTACT_NAME, from_id: BOB, emoji: "👍" }])
    const [message] = await groupWithout([BOB])
    expect(message?.reactions).toEqual([{ from: BOB, from_id: BOB, emoji: "👍" }])
  })

  test("is written @id in the earlier versions of an allowed message", async () => {
    t.ingest(
      inGroup(ALICE, T, { message: `first ${PLACEHOLDER}`, mentions: [{ uuid: BOB, start: 6, length: 1 }] }),
      editFrom(ALICE, T, T + 10, { message: "second" }),
    )
    const [message] = await groupWithout([BOB])
    expect(message?.earlier_versions).toEqual([expect.objectContaining({ text: `first @${BOB}` })])
  })

  test("is shown the same way in a search across chats", async () => {
    t.ingest(inGroup(BOB, T, { message: "needle" }, BOB_STORED_NAME))
    const page = await invoke(
      signalChatRead,
      { method: "search", query: "needle" },
      excludingContext(t.stateDir, [BOB]),
    )
    expect(page.messages?.[0]).toMatchObject({ from: BOB_STORED_NAME, from_id: BOB })
    expect(JSON.stringify(page)).not.toContain(BOB_CONTACT_NAME)
  })
})

describe("chat read: a name stored in an excluded chat", () => {
  /** Ingesting a profile name also stores it as a contact's, which would name the author anyway. */
  const forgetContact = (uuid: string) => t.mirror.prepare("DELETE FROM contacts WHERE uuid = ?").run(uuid)

  test("is not the name of an allowed author, who shows by id", async () => {
    t.ingest(
      inGroup(CAROL, T, { message: "closed" }, "Carol Hidden", OTHER_GROUP_ID),
      inGroup(CAROL, T + 1, { message: "open" }),
    )
    forgetContact(CAROL)
    const [open] = await groupWithout([])
    expect(open).toMatchObject({ from: "Carol Hidden", from_id: CAROL })
    const [message] = await groupWithout([OTHER_GROUP])
    expect(message).toMatchObject({ from: CAROL, from_id: CAROL, text: "open" })
    expect(JSON.stringify(message)).not.toContain("Carol Hidden")
  })

  test("still gives way to a name stored in an allowed chat", async () => {
    t.ingest(
      inGroup(CAROL, T, { message: "closed" }, "Carol Hidden", OTHER_GROUP_ID),
      inGroup(CAROL, T + 1, { message: "open" }, "Carol Open"),
    )
    forgetContact(CAROL)
    expect((await groupWithout([OTHER_GROUP]))[0]).toMatchObject({ from: "Carol Open" })
  })
})

describe("chat read: Note to Self excluded", () => {
  test("still writes the user's own number in a mention as me", async () => {
    t.contacts({ uuid: ME, number: NUMBER })
    t.ingest(
      inGroup(ALICE, T, {
        message: `${PLACEHOLDER} ${PLACEHOLDER}`,
        mentions: [
          { number: NUMBER, start: 0, length: 1 },
          { uuid: ME, number: NUMBER, start: 2, length: 1 },
        ],
      }),
    )
    const [message] = await groupWithout([ME])
    expect(message?.text).toBe("@me @me")
    expect(JSON.stringify(message)).not.toContain(NUMBER)
  })
})
