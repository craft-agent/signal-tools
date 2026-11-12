import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { callDescription } from "../describe"
import { GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, deleteFrom, GROUP_ID, ME } from "../signal/mirror.testing"
import { AT, createActionFixture, OWN, type ActionFixture } from "./action.testing"
import { ACTION_WINDOW_MS } from "./constants"
import { signalMessageDelete } from "./delete"
import { MESSAGE_WORDS } from "./words"

let t: ActionFixture

beforeEach(() => {
  t = createActionFixture()
  setSystemTime(new Date(AT))
  t.ownMessage(OWN, { message: "first" })
})

afterEach(async () => {
  setSystemTime()
  await t.close()
})

const ID = messageId(ME, OWN)

function describeCall(args: Record<string, unknown>) {
  return callDescription(signalMessageDelete, args, { cwd: t.stateDir, stateDir: t.stateDir })
}

describe("a deletion of a message to a person", () => {
  test("names the person and shows the message, with no text section", async () => {
    expect(await describeCall({ chat: ALICE, id: ID })).toEqual({
      headline: { text: MESSAGE_WORDS.deleteHeadline, values: { chat: "Alice" } },
      facts: [
        { label: "Chat", value: { text: MESSAGE_WORDS.person } },
        { label: "Message", value: "first" },
      ],
    })
  })

  test("shows the latest edit as the message", async () => {
    t.ownEdit(OWN, OWN + 1000, "second")
    const description = await describeCall({ chat: ALICE, id: ID })
    expect(description?.facts).toContainEqual({ label: "Message", value: "second" })
  })

  test("counts the files of a message with files", async () => {
    t.ownMessage(OWN + 1, {
      message: "look",
      attachments: [
        { id: "a1", contentType: "image/png" },
        { id: "a2", contentType: "image/png" },
      ],
    })
    const description = await describeCall({ chat: ALICE, id: messageId(ME, OWN + 1) })
    expect(description?.facts).toEqual([
      { label: "Chat", value: { text: MESSAGE_WORDS.person } },
      { label: "Message", value: "look" },
      { label: "Files", value: { text: MESSAGE_WORDS.filesCount, values: { count: 2 } } },
    ])
  })

  test("shows `(no text)` for a message with only a file", async () => {
    t.ownMessage(OWN + 1, { attachments: [{ id: "a1", contentType: "image/png" }] })
    const description = await describeCall({ chat: ALICE, id: messageId(ME, OWN + 1) })
    expect(description?.facts).toEqual([
      { label: "Chat", value: { text: MESSAGE_WORDS.person } },
      { label: "Message", value: { text: MESSAGE_WORDS.noText } },
      { label: "Files", value: { text: MESSAGE_WORDS.file, values: { count: 1 } } },
    ])
  })
})

describe("a deletion in a group", () => {
  test("counts the members after the message", async () => {
    t.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: ME }] })
    t.ownMessage(OWN + 10, { message: "hello team" }, GROUP)
    const description = await describeCall({ chat: GROUP, id: messageId(ME, OWN + 10) })
    expect(description?.headline).toEqual({ text: MESSAGE_WORDS.deleteHeadline, values: { chat: "Team" } })
    expect(description?.facts).toEqual([
      { label: "Chat", value: { text: MESSAGE_WORDS.group } },
      { label: "Message", value: "hello team" },
      { label: "Members", value: { text: MESSAGE_WORDS.membersCount, values: { count: 2 } } },
    ])
    expect(description?.pins).toEqual({ members: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})

describe("a deletion of a disappearing or view-once message", () => {
  test("shows a disappearing message's text but not a view-once message's", async () => {
    t.ownMessage(OWN + 30, { message: "fleeting", expiresInSeconds: 3600 })
    t.ownMessage(OWN + 31, { message: "look", viewOnce: true })
    const disappearing = await describeCall({ chat: ALICE, id: messageId(ME, OWN + 30) })
    const viewOnce = await describeCall({ chat: ALICE, id: messageId(ME, OWN + 31) })
    expect(disappearing?.facts).toContainEqual({ label: "Message", value: "fleeting" })
    expect(viewOnce?.facts).toContainEqual({ label: "Message", value: { text: MESSAGE_WORDS.viewOnce } })
    expect(JSON.stringify(viewOnce)).not.toContain("look")
  })
})

describe("a deletion in Note to Self", () => {
  test("has its own headline and no Chat fact", async () => {
    t.ownMessage(OWN + 20, { message: "remember" }, ME)
    expect(await describeCall({ chat: ME, id: messageId(ME, OWN + 20) })).toEqual({
      headline: { text: MESSAGE_WORDS.deleteHeadlineNote },
      facts: [{ label: "Message", value: "remember" }],
    })
  })
})

describe("a call that would be refused", () => {
  test("another person's message has no description", async () => {
    expect(await describeCall({ chat: ALICE, id: messageId(ALICE, 5000) })).toBeUndefined()
  })

  test("a message older than 24 hours has no description", async () => {
    setSystemTime(new Date(OWN + ACTION_WINDOW_MS + 1))
    expect(await describeCall({ chat: ALICE, id: ID })).toBeUndefined()
  })

  test("an unknown id has no description", async () => {
    expect(await describeCall({ chat: ALICE, id: messageId(ME, OWN + 999) })).toBeUndefined()
  })

  test("a message already deleted has no description", async () => {
    t.ingest(deleteFrom(ME, OWN))
    expect(await describeCall({ chat: ALICE, id: ID })).toBeUndefined()
  })
})

describe("pinning", () => {
  test("the same call described at two times within the window gives the same description", async () => {
    const args = { chat: ALICE, id: ID }
    const first = await describeCall(args)
    setSystemTime(new Date(AT + 3_600_000))
    expect(await describeCall(args)).toEqual(first)
    expect(first).toBeDefined()
  })
})
