import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { callDescription } from "../describe"
import { ALICE_NUMBER, CAROL, GROUP, OTHER_GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, dataFrom, deleteFrom, GROUP_ID, ME } from "../signal/mirror.testing"
import { createSendFixture, type SendFixture } from "./send.testing"
import { signalMessageSend } from "./send"
import { MESSAGE_WORDS } from "./words"

let t: SendFixture

beforeEach(() => {
  t = createSendFixture()
})

afterEach(async () => {
  setSystemTime()
  await t.close()
})

function describeCall(args: Record<string, unknown>) {
  return callDescription(signalMessageSend, args, { cwd: t.stateDir, stateDir: t.stateDir })
}

describe("a message to a person", () => {
  test("names the person, shows the trimmed text and has no members", async () => {
    expect(await describeCall({ chat: ALICE, text: "  hello  \n" })).toEqual({
      headline: { text: MESSAGE_WORDS.sendHeadline, values: { chat: "Alice" } },
      facts: [{ label: "Chat", value: { text: MESSAGE_WORDS.person } }],
      text: { label: MESSAGE_WORDS.sendText, body: "hello" },
    })
  })

  test("without a known name has no headline, and no number anywhere", async () => {
    t.contacts({ uuid: CAROL, number: ALICE_NUMBER })
    t.ingest(dataFrom(CAROL, 6000, { message: "hi" }))
    const description = await describeCall({ chat: CAROL, text: "hello" })
    expect(description?.headline).toBeUndefined()
    expect(description?.facts).toEqual([{ label: "Chat", value: { text: MESSAGE_WORDS.person } }])
    expect(JSON.stringify(description)).not.toContain("5555")
  })
})

describe("a message to a group", () => {
  test("names the group and counts its members", async () => {
    t.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: ME }] })
    expect(await describeCall({ chat: GROUP, text: "hello team" })).toEqual({
      headline: { text: MESSAGE_WORDS.sendHeadline, values: { chat: "Team" } },
      facts: [
        { label: "Chat", value: { text: MESSAGE_WORDS.group } },
        { label: "Members", value: { text: MESSAGE_WORDS.membersCount, values: { count: 2 } } },
      ],
      text: { label: MESSAGE_WORDS.sendText, body: "hello team" },
      pins: { members: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
  })
})

describe("a message to Note to Self", () => {
  test("has its own headline and no Chat fact", async () => {
    expect(await describeCall({ chat: ME, text: "remember" })).toEqual({
      headline: { text: MESSAGE_WORDS.sendHeadlineNote },
      facts: [],
      text: { label: MESSAGE_WORDS.sendText, body: "remember" },
    })
  })
})

describe("a reply", () => {
  test("shows the quoted text between the Chat and Members facts", async () => {
    t.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: ME }] })
    const description = await describeCall({ chat: GROUP, text: "agreed", reply_to: messageId(ALICE, 2000) })
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "Reply to", "Members"])
    expect(description?.facts[1]).toEqual({ label: "Reply to", value: "hello team" })
  })

  test("hides a quoted view-once message but shows a disappearing message's text", async () => {
    t.ingest(dataFrom(ALICE, 5700, { message: "look", viewOnce: true }))
    t.ingest(dataFrom(ALICE, 5800, { message: "fleeting", expiresInSeconds: 3600 }))
    const viewOnce = await describeCall({ chat: ALICE, text: "ok", reply_to: messageId(ALICE, 5700) })
    const disappearing = await describeCall({ chat: ALICE, text: "ok", reply_to: messageId(ALICE, 5800) })
    expect(viewOnce?.facts).toContainEqual({ label: "Reply to", value: { text: MESSAGE_WORDS.viewOnce } })
    expect(disappearing?.facts).toContainEqual({ label: "Reply to", value: "fleeting" })
    expect(JSON.stringify(viewOnce)).not.toContain("look")
  })

  test("shows mentions in the quoted text as names", async () => {
    t.ingest(dataFrom(ALICE, 5900, { message: "Hi \uFFFC", mentions: [{ uuid: ALICE, start: 3, length: 1 }] }))
    const description = await describeCall({ chat: ALICE, text: "ok", reply_to: messageId(ALICE, 5900) })
    expect(description?.facts).toContainEqual({ label: "Reply to", value: "Hi @Alice" })
  })

  test("shows `(no text)` for a quoted message without text", async () => {
    t.ingest(dataFrom(ALICE, 5600, { attachments: [{ id: "f1", contentType: "image/png", filename: "a.png" }] }))
    const description = await describeCall({ chat: ALICE, text: "nice", reply_to: messageId(ALICE, 5600) })
    expect(description?.facts).toContainEqual({ label: "Reply to", value: { text: MESSAGE_WORDS.noText } })
  })
})

describe("a call that would be refused", () => {
  test.each([
    ["an unknown chat", { chat: "nobody", text: "hi" }],
    ["a group the user left", { chat: OTHER_GROUP, text: "hi" }],
    ["blank text", { chat: ALICE, text: " \n " }],
    ["a message that is not known", { chat: ALICE, text: "hi", reply_to: messageId(ALICE, 9999) }],
    ["a reply_to that is not a message id", { chat: ALICE, text: "hi", reply_to: "not-an-id" }],
  ])("%s has no description", async (_name, args) => {
    expect(await describeCall(args)).toBeUndefined()
  })

  test("a message deleted for everyone has no description", async () => {
    t.ingest(deleteFrom(ALICE, 5000))
    expect(await describeCall({ chat: ALICE, text: "hi", reply_to: messageId(ALICE, 5000) })).toBeUndefined()
  })
})

describe("pinning", () => {
  test("the same call described twice, a moment apart, gives the same description", async () => {
    const args = { chat: ALICE, text: "hello", reply_to: messageId(ALICE, 5000) }
    setSystemTime(new Date(1_800_000_000_000))
    const first = await describeCall(args)
    setSystemTime(new Date(1_800_000_060_000))
    expect(await describeCall(args)).toEqual(first)
    expect(first).toBeDefined()
  })
})
