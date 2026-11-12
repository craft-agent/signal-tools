import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { withMirror } from "../chat/open"
import { ALICE_NUMBER, CAROL, GROUP, OTHER_GROUP } from "../chat/read.testing"
import { ALICE, BOB, dataFrom, GROUP_ID, ME } from "../signal/mirror.testing"
import {
  authorFacts,
  chatFacts,
  chatHeadline,
  chatSubject,
  filesFacts,
  membersFacts,
  messageTextFact,
  writtenFact,
} from "./describe"
import { prepareChat } from "./prepare"
import { createSendFixture, type SendFixture } from "./send.testing"
import { MESSAGE_WORDS } from "./words"

let fixture: SendFixture

beforeEach(() => {
  fixture = createSendFixture()
})

afterEach(async () => {
  await fixture.close()
})

function subjectOf(chat: string) {
  return withMirror(fixture, undefined, (mirror, me) => chatSubject(mirror, prepareChat(mirror, me, chat, "send")))
}

function authorsOf(author: string, chat = ME) {
  return withMirror(fixture, undefined, (mirror, me) =>
    authorFacts(chatSubject(mirror, prepareChat(mirror, me, chat, "send")), author),
  )
}

describe("a person's chat", () => {
  test("is named by the mirror, is a Person, and has no members", async () => {
    const subject = await subjectOf(ALICE)
    expect(subject.name).toBe("Alice")
    expect(subject.members).toBeNull()
    expect(chatFacts(subject)).toEqual([{ label: "Chat", value: { text: MESSAGE_WORDS.person } }])
    expect(membersFacts(subject)).toEqual([])
    expect(chatHeadline(subject, "Send to {chat}", "Send to yourself")).toEqual({
      text: "Send to {chat}",
      values: { chat: "Alice" },
    })
  })

  test("keeps the template's other values beside the chat", async () => {
    const subject = await subjectOf(ALICE)
    expect(chatHeadline(subject, "React {emoji} in {chat}", "React {emoji}", { emoji: "+1" })?.values).toEqual({
      emoji: "+1",
      chat: "Alice",
    })
  })

  test("with only a number has no name, no headline and no number in its facts", async () => {
    fixture.contacts({ uuid: CAROL, number: ALICE_NUMBER })
    fixture.ingest(dataFrom(CAROL, 6000, { message: "hi" }))
    const subject = await subjectOf(CAROL)
    expect(subject.name).toBeNull()
    expect(chatHeadline(subject, "Send to {chat}", "Send to yourself")).toBeUndefined()
    const facts = JSON.stringify([...chatFacts(subject), ...membersFacts(subject)])
    expect(facts).not.toContain(ALICE_NUMBER)
    expect(facts).not.toContain("5555")
  })
})

describe("a group's chat", () => {
  test("is named by its title, is a Group, and counts its members", async () => {
    fixture.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: BOB }, { uuid: ME }] })
    const subject = await subjectOf(GROUP)
    expect(subject.name).toBe("Team")
    expect(subject.members).toBe(3)
    expect(chatFacts(subject)).toEqual([{ label: "Chat", value: { text: MESSAGE_WORDS.group } }])
    expect(membersFacts(subject)).toEqual([
      { label: "Members", value: { text: MESSAGE_WORDS.membersCount, values: { count: 3 } } },
    ])
  })

  test("with one member says `member` in the singular", async () => {
    const subject = await subjectOf(GROUP)
    expect(subject.members).toBe(1)
    expect(membersFacts(subject)).toEqual([
      { label: "Members", value: { text: MESSAGE_WORDS.member, values: { count: 1 } } },
    ])
  })

  test("without a title has no name and no headline", async () => {
    fixture.groups({ id: GROUP_ID, name: "  ", members: [{ uuid: ALICE }] })
    const subject = await subjectOf(GROUP)
    expect(subject.name).toBeNull()
    expect(chatHeadline(subject, "Send to {chat}", "Send to yourself")).toBeUndefined()
  })

  test("is not described when the user left it", async () => {
    await expect(subjectOf(OTHER_GROUP)).rejects.toThrow()
  })
})

describe("Note to Self", () => {
  test("has no name, no Chat fact and the headline of its own", async () => {
    const subject = await subjectOf(ME)
    expect(subject.name).toBeNull()
    expect(subject.members).toBeNull()
    expect(chatFacts(subject)).toEqual([])
    expect(chatHeadline(subject, "Send to {chat}", "Send to yourself")).toEqual({ text: "Send to yourself" })
  })
})

describe("writtenFact", () => {
  test("holds the text as it is", () => {
    expect(writtenFact("Message", "  hello\nthere ")).toEqual({ label: "Message", value: "  hello\nthere " })
  })

  test.each([null, "", "  \n "])("holds `(no text)` for %p", (text) => {
    expect(writtenFact("Message", text)).toEqual({ label: "Message", value: { text: MESSAGE_WORDS.noText } })
  })
})

describe("filesFacts", () => {
  test("counts the files, in the singular for one and as nothing for none", () => {
    expect(filesFacts(3)).toEqual([{ label: "Files", value: { text: "{count} files", values: { count: 3 } } }])
    expect(filesFacts(1)).toEqual([{ label: "Files", value: { text: "{count} file", values: { count: 1 } } }])
    expect(filesFacts(0)).toEqual([])
  })
})

describe("authorFacts", () => {
  test("says `you` for the user's own message", async () => {
    expect(await authorsOf(ME)).toEqual([{ label: "From", value: { text: MESSAGE_WORDS.you } }])
  })

  test("names a person the mirror knows", async () => {
    expect(await authorsOf(ALICE)).toEqual([{ label: "From", value: "Alice" }])
  })

  test("is none for an author without a known name", async () => {
    expect(await authorsOf(CAROL)).toEqual([])
  })

  test("is none for the person of a person chat whose name the headline shows", async () => {
    expect(await authorsOf(ALICE, ALICE)).toEqual([])
  })

  test("names the author of a group's message, and says `you` for the user in any chat", async () => {
    expect(await authorsOf(ALICE, GROUP)).toEqual([{ label: "From", value: "Alice" }])
    expect(await authorsOf(ME, ALICE)).toEqual([{ label: "From", value: { text: MESSAGE_WORDS.you } }])
  })
})

describe("messageTextFact", () => {
  const message = { body: "secret", view_once: 0, mentions: [] }

  function factOf(value: Parameters<typeof messageTextFact>[2]) {
    return withMirror(fixture, undefined, (mirror, me) =>
      messageTextFact(chatSubject(mirror, prepareChat(mirror, me, ME, "send")), "Message", value),
    )
  }

  test("holds the text of an ordinary message", async () => {
    expect(await factOf(message)).toEqual({ label: "Message", value: "secret" })
    expect(await factOf({ ...message, body: null })).toEqual({
      label: "Message",
      value: { text: MESSAGE_WORDS.noText },
    })
  })

  test("never holds the text of a view-once message", async () => {
    expect(await factOf({ ...message, view_once: 1 })).toEqual({
      label: "Message",
      value: { text: MESSAGE_WORDS.viewOnce },
    })
  })

  test("loads and names a mention from the mirror", async () => {
    expect(await factOf({ ...message, body: "Hi \uFFFC", mentions: [{ start: 3, uuid: ALICE }] })).toEqual({
      label: "Message",
      value: "Hi @Alice",
    })
  })
})

describe("the members pin of a group", () => {
  const MEMBERS = [{ uuid: ALICE }, { uuid: BOB }, { uuid: ME }]

  test("is the same for the same members in any order", async () => {
    fixture.groups({ id: GROUP_ID, name: "Team", members: MEMBERS })
    const first = (await subjectOf(GROUP)).pins
    fixture.groups({ id: GROUP_ID, name: "Team", members: [...MEMBERS].reverse() })
    expect((await subjectOf(GROUP)).pins).toEqual(first)
    expect(first.members).toMatch(/^[0-9a-f]{64}$/)
  })

  test("changes when one member is replaced", async () => {
    fixture.groups({ id: GROUP_ID, name: "Team", members: MEMBERS })
    const first = (await subjectOf(GROUP)).pins
    fixture.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: CAROL }, { uuid: ME }] })
    expect((await subjectOf(GROUP)).pins).not.toEqual(first)
  })

  test("is none for a person and for Note to Self", async () => {
    expect((await subjectOf(ALICE)).pins).toEqual({})
    expect((await subjectOf(ME)).pins).toEqual({})
  })
})

describe("an unnamed chat's headline", () => {
  test("uses the `unnamed` template with the values alone, when the call gives one", async () => {
    fixture.contacts({ uuid: CAROL, number: ALICE_NUMBER })
    fixture.ingest(dataFrom(CAROL, 6000, { message: "hi" }))
    const subject = await subjectOf(CAROL)
    expect(chatHeadline(subject, "React {emoji} in {chat}", "React {emoji}", { emoji: "+1" }, "React {emoji}")).toEqual(
      { text: "React {emoji}", values: { emoji: "+1" } },
    )
  })
})
