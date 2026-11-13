import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { excludingContext } from "../chat/excluded.testing"
import { BOB_NUMBER, GROUP } from "../chat/read.testing"
import { callDescription } from "../describe"
import { messageId } from "../signal/ids"
import { ALICE, BOB, GROUP_ID, ME, dataFrom, groupDataFrom } from "../signal/mirror.testing"
import { signalMessageReact } from "./react"
import { signalMessageSend } from "./send"
import { createSendFixture, type SendFixture } from "./send.testing"
import { MESSAGE_WORDS } from "./words"

const PLACEHOLDER = "\uFFFC"
const BOB_CONTACT_NAME = "Bob Contact"
const BOB_MESSAGE = 7000

let t: SendFixture

beforeEach(() => {
  t = createSendFixture()
  t.contacts({ uuid: BOB, name: BOB_CONTACT_NAME, number: BOB_NUMBER })
  t.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: BOB }, { uuid: ME }] })
  t.ingest(
    groupDataFrom(BOB, BOB_MESSAGE, {
      message: `ask ${PLACEHOLDER}`,
      mentions: [{ uuid: BOB, number: BOB_NUMBER, start: 4, length: 1 }],
    }),
    dataFrom(
      BOB,
      BOB_MESSAGE + 1,
      { groupInfo: { groupId: GROUP_ID, type: "DELIVER" }, message: "named" },
      {
        sourceName: "Bobby Stored",
      },
    ),
  )
})

afterEach(async () => {
  await t.close()
})

const sendPrompt = (excluded: string[], args: Record<string, unknown>) =>
  callDescription(signalMessageSend, { chat: GROUP, text: "ok", ...args }, excludingContext(t.stateDir, excluded))

const reactPrompt = (excluded: string[], args: Record<string, unknown>) =>
  callDescription(signalMessageReact, { chat: GROUP, emoji: "👍", ...args }, excludingContext(t.stateDir, excluded))

/** Neither the contact name nor the number of the excluded person, nor a stored name, shows in a prompt. */
function expectNothingOfBob(description: unknown): void {
  const shown = JSON.stringify(description)
  expect(shown).not.toContain(BOB_CONTACT_NAME)
  expect(shown).not.toContain(BOB_NUMBER)
  expect(shown).not.toContain("Bobby Stored")
}

describe("an approval prompt in an allowed group, where an excluded person wrote", () => {
  test("a reply to them names no author, and its quoted mention of them is @?", async () => {
    const open = await sendPrompt([], { reply_to: messageId(BOB, BOB_MESSAGE) })
    expect(open?.headline?.values).toMatchObject({ author: BOB_CONTACT_NAME, chat: "Team" })
    expect(JSON.stringify(open?.facts)).toContain(`ask @${BOB_CONTACT_NAME}`)

    const description = await sendPrompt([BOB], { reply_to: messageId(BOB, BOB_MESSAGE) })
    expect(description?.headline).toEqual({ text: MESSAGE_WORDS.replyHeadlineUnnamed, values: { chat: "Team" } })
    expect(JSON.stringify(description?.facts)).toContain("ask @?")
    expectNothingOfBob(description)
  })

  test("a reply to a message they stored a name with still names no author", async () => {
    const description = await sendPrompt([BOB], { reply_to: messageId(BOB, BOB_MESSAGE + 1) })
    expect(description?.headline).toEqual({ text: MESSAGE_WORDS.replyHeadlineUnnamed, values: { chat: "Team" } })
    expectNothingOfBob(description)
  })

  test("a reaction to their message has no From fact, and shows their mention as @?", async () => {
    const open = await reactPrompt([], { id: messageId(BOB, BOB_MESSAGE) })
    expect(open?.facts).toContainEqual({ label: "From", value: BOB_CONTACT_NAME })

    const description = await reactPrompt([BOB], { id: messageId(BOB, BOB_MESSAGE) })
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "Message", "Members"])
    expect(description?.facts).toContainEqual({ label: "Message", value: "ask @?" })
    expectNothingOfBob(description)
  })
})
