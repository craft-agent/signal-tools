import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { callDescription } from "../describe"
import { GROUP, OTHER_GROUP } from "../chat/read.testing"
import { messageId } from "../signal/ids"
import { ALICE, deleteFrom, GROUP_ID, ME } from "../signal/mirror.testing"
import { AT, createActionFixture, OWN, reactionData, type ActionFixture } from "./action.testing"
import { signalMessageReact } from "./react"
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

/** Alice's message in her chat, which the sample chats hold. */
const THEIRS = messageId(ALICE, 5000)

function describeCall(args: Record<string, unknown>) {
  return callDescription(signalMessageReact, args, { cwd: t.stateDir, stateDir: t.stateDir })
}

describe("a reaction to another person's message", () => {
  test("names the emoji and the person, and shows the author and the message", async () => {
    expect(await describeCall({ chat: ALICE, id: THEIRS, emoji: "👍" })).toEqual({
      headline: { text: MESSAGE_WORDS.reactHeadline, values: { emoji: "👍", chat: "Alice" } },
      facts: [
        { label: "Chat", value: { text: MESSAGE_WORDS.person } },
        { label: "From", value: "Alice" },
        { label: "Message", value: "hello from Alice" },
      ],
    })
  })

  test("that replaces an earlier reaction says what it replaces", async () => {
    t.ownMessage(OWN + 500, reactionData(ALICE, 5000, "❤️"))
    const description = await describeCall({ chat: ALICE, id: THEIRS, emoji: "👍" })
    expect(description?.headline).toEqual({ text: MESSAGE_WORDS.reactHeadline, values: { emoji: "👍", chat: "Alice" } })
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "Replaces", "From", "Message"])
    expect(description?.facts[1]).toEqual({ label: "Replaces", value: "❤️" })
  })
})

describe("removing a reaction", () => {
  test("has the remove headline with the current emoji and no Replaces", async () => {
    t.ownMessage(OWN + 500, reactionData(ALICE, 5000, "❤️"))
    const description = await describeCall({ chat: ALICE, id: THEIRS, remove: true })
    expect(description?.headline).toEqual({
      text: MESSAGE_WORDS.unreactHeadline,
      values: { emoji: "❤️", chat: "Alice" },
    })
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "From", "Message"])
  })
})

describe("a reaction to the user's own message", () => {
  test("says the author is you", async () => {
    const description = await describeCall({ chat: ALICE, id: messageId(ME, OWN), emoji: "❤️" })
    expect(description?.facts).toContainEqual({ label: "From", value: { text: MESSAGE_WORDS.you } })
    expect(description?.facts).toContainEqual({ label: "Message", value: "first" })
  })
})

describe("a reaction in a group", () => {
  test("ends with the members", async () => {
    t.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: ME }] })
    expect(await describeCall({ chat: GROUP, id: messageId(ALICE, 2000), emoji: "😂" })).toEqual({
      headline: { text: MESSAGE_WORDS.reactHeadline, values: { emoji: "😂", chat: "Team" } },
      facts: [
        { label: "Chat", value: { text: MESSAGE_WORDS.group } },
        { label: "From", value: "Alice" },
        { label: "Message", value: "hello team" },
        { label: "Members", value: { text: MESSAGE_WORDS.membersCount, values: { count: 2 } } },
      ],
    })
  })
})

describe("a reaction in Note to Self", () => {
  test("has its own headline and no Chat fact", async () => {
    t.ownMessage(OWN + 20, { message: "remember" }, ME)
    expect(await describeCall({ chat: ME, id: messageId(ME, OWN + 20), emoji: "👍" })).toEqual({
      headline: { text: MESSAGE_WORDS.reactHeadlineNote, values: { emoji: "👍" } },
      facts: [
        { label: "From", value: { text: MESSAGE_WORDS.you } },
        { label: "Message", value: "remember" },
      ],
    })
  })
})

describe("a call that would be refused", () => {
  test("the emoji already there has no description", async () => {
    t.ownMessage(OWN + 500, reactionData(ALICE, 5000, "👍"))
    expect(await describeCall({ chat: ALICE, id: THEIRS, emoji: "👍" })).toBeUndefined()
  })

  test("removing with no reaction there has no description", async () => {
    expect(await describeCall({ chat: ALICE, id: THEIRS, remove: true })).toBeUndefined()
  })

  test("an unknown message has no description", async () => {
    expect(await describeCall({ chat: ALICE, id: messageId(ALICE, 9999), emoji: "👍" })).toBeUndefined()
  })

  test("a deleted message has no description", async () => {
    t.ingest(deleteFrom(ME, OWN))
    expect(await describeCall({ chat: ALICE, id: messageId(ME, OWN), emoji: "👍" })).toBeUndefined()
  })

  test("a group the user left has no description", async () => {
    expect(await describeCall({ chat: OTHER_GROUP, id: THEIRS, emoji: "👍" })).toBeUndefined()
  })
})

describe("pinning", () => {
  test("the same call described at two clock times gives the same description", async () => {
    const args = { chat: ALICE, id: THEIRS, emoji: "👍" }
    const first = await describeCall(args)
    setSystemTime(new Date(AT + 3_600_000))
    expect(await describeCall(args)).toEqual(first)
    expect(first).toBeDefined()
  })
})
