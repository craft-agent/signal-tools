import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { callDescription } from "../describe"
import { GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, GROUP_ID, ME } from "../signal/mirror.testing"
import { AT, createActionFixture, OWN, type ActionFixture } from "./action.testing"
import { ACTION_WINDOW_MS } from "./constants"
import { signalMessageEdit } from "./edit"
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
  return callDescription(signalMessageEdit, args, { cwd: t.stateDir, stateDir: t.stateDir })
}

describe("an edit of a message to a person", () => {
  test("names the person and shows the current and the new text", async () => {
    expect(await describeCall({ chat: ALICE, id: ID, text: "  second \n" })).toEqual({
      headline: { text: MESSAGE_WORDS.editHeadline, values: { chat: "Alice" } },
      facts: [
        { label: "Chat", value: { text: MESSAGE_WORDS.person } },
        { label: "Current", value: "first" },
      ],
      text: { label: MESSAGE_WORDS.editText, body: "second" },
    })
  })

  test("shows the latest edit as the current text", async () => {
    t.ownEdit(OWN, OWN + 1000, "second")
    const description = await describeCall({ chat: ALICE, id: ID, text: "third" })
    expect(description?.facts).toContainEqual({ label: "Current", value: "second" })
  })

  test("does not show the edits left", async () => {
    const description = await describeCall({ chat: ALICE, id: ID, text: "second" })
    expect(JSON.stringify(description)).not.toContain("left")
  })
})

describe("an edit in a group", () => {
  test("counts the members after the current text", async () => {
    t.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: ME }] })
    t.ownMessage(OWN + 10, { message: "hello team" }, GROUP)
    const description = await describeCall({ chat: GROUP, id: messageId(ME, OWN + 10), text: "hello again" })
    expect(description?.headline).toEqual({ text: MESSAGE_WORDS.editHeadline, values: { chat: "Team" } })
    expect(description?.facts).toEqual([
      { label: "Chat", value: { text: MESSAGE_WORDS.group } },
      { label: "Current", value: "hello team" },
      { label: "Members", value: { text: MESSAGE_WORDS.membersCount, values: { count: 2 } } },
    ])
    expect(description?.pins).toEqual({ members: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})

describe("an edit of a disappearing message", () => {
  test("never shows its current text", async () => {
    t.ownMessage(OWN + 30, { message: "fleeting", expiresInSeconds: 3600 })
    const description = await describeCall({ chat: ALICE, id: messageId(ME, OWN + 30), text: "second" })
    expect(description?.facts).toContainEqual({ label: "Current", value: { text: MESSAGE_WORDS.disappearing } })
    expect(JSON.stringify(description?.facts)).not.toContain("fleeting")
    expect(description?.text?.body).toBe("second")
  })
})

describe("an edit in Note to Self", () => {
  test("has its own headline and no Chat fact", async () => {
    t.ownMessage(OWN + 20, { message: "remember" }, ME)
    expect(await describeCall({ chat: ME, id: messageId(ME, OWN + 20), text: "remember more" })).toEqual({
      headline: { text: MESSAGE_WORDS.editHeadlineNote },
      facts: [{ label: "Current", value: "remember" }],
      text: { label: MESSAGE_WORDS.editText, body: "remember more" },
    })
  })
})

describe("a call that would be refused", () => {
  test("another person's message has no description", async () => {
    expect(await describeCall({ chat: ALICE, id: messageId(ALICE, 5000), text: "second" })).toBeUndefined()
  })

  test("a message older than 24 hours has no description", async () => {
    setSystemTime(new Date(OWN + ACTION_WINDOW_MS + 1))
    expect(await describeCall({ chat: ALICE, id: ID, text: "second" })).toBeUndefined()
  })

  test("a text equal to the current one has no description", async () => {
    expect(await describeCall({ chat: ALICE, id: ID, text: " first " })).toBeUndefined()
  })

  test("a message with files has no description", async () => {
    t.ownMessage(OWN + 1, { message: "look", attachments: [{ id: "a1", contentType: "image/png", filename: "a.png" }] })
    expect(await describeCall({ chat: ALICE, id: messageId(ME, OWN + 1), text: "second" })).toBeUndefined()
  })

  test("an unknown id and blank text have no description", async () => {
    expect(await describeCall({ chat: ALICE, id: messageId(ME, OWN + 999), text: "second" })).toBeUndefined()
    expect(await describeCall({ chat: ALICE, id: ID, text: " " })).toBeUndefined()
  })
})

describe("pinning", () => {
  test("the same call described at two times within the window gives the same description", async () => {
    const args = { chat: ALICE, id: ID, text: "second" }
    const first = await describeCall(args)
    setSystemTime(new Date(AT + 3_600_000))
    expect(await describeCall(args)).toEqual(first)
    expect(first).toBeDefined()
  })
})
