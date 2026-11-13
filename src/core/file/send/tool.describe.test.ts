import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALICE_NUMBER, CAROL, GROUP } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { MAX_TEXT_CHARACTERS } from "../../message/constants"
import { MESSAGE_WORDS } from "../../message/words"
import { messageId } from "../../signal/ids"
import { ALICE, dataFrom, groupDataFrom, GROUP_ID, ME, sentTo } from "../../signal/mirror.testing"
import { promptTime } from "../../time"
import { FILE_WORDS } from "../words"
import { createFileSend, signalFileSend } from "./tool"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
})

afterEach(async () => {
  setSystemTime()
  await t.close()
})

function describeCall(args: Record<string, unknown>) {
  return callDescription(signalFileSend, args, { cwd: t.work, stateDir: t.stateDir })
}

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

describe("one file to a person", () => {
  test("names the file, the person, the size, and pins the content", async () => {
    const path = t.write("report.txt", "twelve bytes")
    expect(await describeCall({ chat: ALICE, files: [{ path: "report.txt" }] })).toEqual({
      headline: { text: FILE_WORDS.sendOneHeadline, values: { file: "report.txt", chat: "Alice" } },
      facts: [
        { label: "Chat", value: { text: MESSAGE_WORDS.person } },
        { label: "Size", value: { text: "{bytes} bytes", values: { bytes: 12 } } },
      ],
      pins: { [`sha256:${path}`]: sha256Of("twelve bytes") },
    })
  })
})

describe("several files to a group", () => {
  test("has the files headline, Members, the Files count and the total size", async () => {
    t.groups({ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }, { uuid: ME }] })
    const first = t.write("a.txt", "abc")
    const second = t.write("b.txt", "defgh")
    expect(await describeCall({ chat: GROUP, files: [{ path: "a.txt" }, { path: "b.txt" }] })).toEqual({
      headline: { text: FILE_WORDS.sendHeadline, values: { chat: "Team" } },
      facts: [
        { label: "Chat", value: { text: MESSAGE_WORDS.group } },
        { label: "Members", value: { text: MESSAGE_WORDS.membersCount, values: { count: 2 } } },
        { label: "Files", value: { text: MESSAGE_WORDS.filesCount, values: { count: 2 } } },
        { label: "Size", value: { text: "{bytes} bytes", values: { bytes: 8 } } },
      ],
      pins: {
        members: expect.stringMatching(/^[0-9a-f]{64}$/),
        [`sha256:${first}`]: sha256Of("abc"),
        [`sha256:${second}`]: sha256Of("defgh"),
      },
    })
  })
})

describe("Note to Self", () => {
  test("has its own headlines and no Chat fact", async () => {
    t.write("a.txt", "x")
    t.write("b.txt", "y")
    const one = await describeCall({ chat: ME, files: [{ path: "a.txt" }] })
    expect(one?.headline).toEqual({ text: FILE_WORDS.sendOneHeadlineNote, values: { file: "a.txt" } })
    expect(one?.facts.map((fact) => fact.label)).toEqual(["Size"])
    const many = await describeCall({ chat: ME, files: [{ path: "a.txt" }, { path: "b.txt" }] })
    expect(many?.headline).toEqual({ text: FILE_WORDS.sendHeadlineNote })
  })
})

describe("the caption", () => {
  test("is the text, trimmed, and is left out when there is none", async () => {
    t.write("a.txt", "x")
    const files = [{ path: "a.txt" }]
    expect((await describeCall({ chat: ALICE, files, text: "  look  " }))?.text).toEqual({
      label: FILE_WORDS.caption,
      body: "look",
    })
    expect(await describeCall({ chat: ALICE, files })).not.toHaveProperty("text")
    expect(await describeCall({ chat: ALICE, files, text: "  " })).not.toHaveProperty("text")
  })
})

describe("a reply", () => {
  test("shows the quoted text after the Chat fact", async () => {
    t.write("a.txt", "x")
    const description = await describeCall({
      chat: ALICE,
      files: [{ path: "a.txt" }],
      reply_to: messageId(ALICE, 5000),
    })
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "Reply to", "Size"])
    expect(description?.facts[1]).toEqual({
      label: "Reply to",
      value: { text: MESSAGE_WORDS.replyText, values: { time: promptTime(5000), text: "hello from Alice" } },
    })
  })

  test.each([1, 2])("selects all reply headlines for %i files", async (count) => {
    t.write("a.txt", "x")
    t.write("b.txt", "y")
    t.contacts({ uuid: CAROL, number: ALICE_NUMBER })
    t.ingest(
      sentTo(ALICE, 6000, { message: "mine" }),
      groupDataFrom(CAROL, 6100, { message: "hi" }),
      dataFrom(CAROL, 6200, { message: "hi" }),
    )
    const files = [{ path: "a.txt" }, { path: "b.txt" }].slice(0, count)
    const file: Record<string, string> = count === 1 ? { file: "a.txt" } : {}
    const cases = [
      {
        chat: GROUP,
        author: ALICE,
        ts: 2000,
        text: count === 1 ? FILE_WORDS.replyOneHeadline : FILE_WORDS.replyHeadline,
        values: { ...file, author: "Alice", chat: "Team" },
      },
      {
        chat: ALICE,
        author: ALICE,
        ts: 5000,
        text: count === 1 ? FILE_WORDS.replyOneHeadlinePerson : FILE_WORDS.replyHeadlinePerson,
        values: { ...file, chat: "Alice" },
      },
      {
        chat: ALICE,
        author: ME,
        ts: 6000,
        text: count === 1 ? FILE_WORDS.replyOneHeadlineOwn : FILE_WORDS.replyHeadlineOwn,
        values: { ...file, chat: "Alice" },
      },
      {
        chat: GROUP,
        author: CAROL,
        ts: 6100,
        text: count === 1 ? FILE_WORDS.replyOneHeadlineUnnamed : FILE_WORDS.replyHeadlineUnnamed,
        values: { ...file, chat: "Team" },
      },
      {
        chat: ME,
        author: ME,
        ts: 4000,
        text: count === 1 ? FILE_WORDS.replyOneHeadlineNote : FILE_WORDS.replyHeadlineNote,
        ...(count === 1 && { values: file }),
      },
    ]
    for (const { chat, author, ts, text, values } of cases) {
      const description = await describeCall({ chat, files, reply_to: messageId(author, ts) })
      expect(description?.headline).toEqual({ text, ...(values && { values }) })
      expect(JSON.stringify(description)).not.toContain(ALICE_NUMBER)
      expect(JSON.stringify(description)).not.toContain(CAROL)
    }
    const unnamed = await describeCall({ chat: CAROL, files, reply_to: messageId(CAROL, 6200) })
    expect(unnamed?.headline).toBeUndefined()
    expect(JSON.stringify(unnamed)).not.toContain(ALICE_NUMBER)
  })

  test.each([
    [
      { message: "Hi \uFFFC", mentions: [{ uuid: ALICE, start: 3, length: 1 }] },
      MESSAGE_WORDS.replyText,
      { text: "Hi @Alice" },
    ],
    [{ message: "hidden", viewOnce: true }, MESSAGE_WORDS.replyViewOnce, {}],
    [
      {
        attachments: [
          { id: "f1", contentType: "image/png", filename: " a.png " },
          { id: "f2", filename: "b.png" },
        ],
      },
      MESSAGE_WORDS.replyFiles,
      { files: "a.png, b.png" },
    ],
    [{ attachments: [{ id: "f1", contentType: "image/png" }] }, MESSAGE_WORDS.replyFile, { count: 1 }],
    [
      {
        attachments: [
          { id: "f1", contentType: "image/png", filename: "a.png" },
          { id: "f2", filename: " " },
        ],
      },
      MESSAGE_WORDS.replyFilesCount,
      { count: 2 },
    ],
    [{ message: " " }, MESSAGE_WORDS.replyNoText, {}],
  ])("shows the quoted content %j", async (data, text, values) => {
    t.write("a.txt", "x")
    t.ingest(dataFrom(ALICE, 6000, data))
    const description = await describeCall({
      chat: ALICE,
      files: [{ path: "a.txt" }],
      reply_to: messageId(ALICE, 6000),
    })
    expect(description?.facts).toContainEqual({
      label: "Reply to",
      value: { text, values: { time: promptTime(6000), ...values } },
    })
    expect(JSON.stringify(description)).not.toContain("hidden")
  })
})

describe("a call that would be refused", () => {
  test("a sticker-only message has no description", async () => {
    t.write("a.txt", "x")
    t.ingest(dataFrom(ALICE, 5700, { sticker: { packId: "ab", stickerId: 1 } }))
    expect(
      await describeCall({ chat: ALICE, files: [{ path: "a.txt" }], reply_to: messageId(ALICE, 5700) }),
    ).toBeUndefined()
  })

  test("a file outside the allowed directories has no description", async () => {
    const outside = mkdtempSync(join(tmpdir(), "send-outside-"))
    try {
      const path = join(outside, "x.txt")
      await Bun.write(path, "x")
      expect(await describeCall({ chat: ALICE, files: [{ path }] })).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("a sha256 that does not match the file has no description, in any case when it does", async () => {
    t.write("a.txt", "x")
    expect(await describeCall({ chat: ALICE, files: [{ path: "a.txt", sha256: "0".repeat(64) }] })).toBeUndefined()
    const matching = sha256Of("x").toUpperCase()
    expect(await describeCall({ chat: ALICE, files: [{ path: "a.txt", sha256: matching }] })).toBeDefined()
  })

  test("files over the size limit have no description", async () => {
    t.write("a.txt", "x".repeat(60))
    t.write("b.txt", "y".repeat(60))
    const small = createFileSend({ maxTotalBytes: 100 })
    const describeWith = (files: { path: string }[]) =>
      callDescription(small, { chat: ALICE, files }, { cwd: t.work, stateDir: t.stateDir })
    expect(await describeWith([{ path: "a.txt" }])).toBeDefined()
    expect(await describeWith([{ path: "a.txt" }, { path: "b.txt" }])).toBeUndefined()
  })

  test.each([
    ["the same file twice", { chat: ALICE, files: [{ path: "a.txt" }, { path: "a.txt" }] }],
    ["an unknown chat", { chat: "nobody", files: [{ path: "a.txt" }] }],
    [
      "a caption over the limit",
      { chat: ALICE, files: [{ path: "a.txt" }], text: "x".repeat(MAX_TEXT_CHARACTERS + 1) },
    ],
    ["a file that does not exist", { chat: ALICE, files: [{ path: "missing.txt" }] }],
  ])("%s has no description", async (_name, args) => {
    t.write("a.txt", "x")
    expect(await describeCall(args)).toBeUndefined()
  })
})

describe("pinning", () => {
  test("a file rewritten with the same size changes the pins", async () => {
    const args = { chat: ALICE, files: [{ path: "a.txt" }] }
    t.write("a.txt", "before")
    const before = await describeCall(args)
    t.write("a.txt", "after!")
    const after = await describeCall(args)
    expect(after?.facts).toEqual(before?.facts)
    expect(after?.pins).not.toEqual(before?.pins)
  })

  test("the same call described twice, a moment apart, gives the same description", async () => {
    t.write("a.txt", "x")
    const args = { chat: ALICE, files: [{ path: "a.txt" }], text: "hi", reply_to: messageId(ALICE, 5000) }
    setSystemTime(new Date(1_800_000_000_000))
    const first = await describeCall(args)
    setSystemTime(new Date(1_800_000_060_000))
    expect(await describeCall(args)).toEqual(first)
    expect(first).toBeDefined()
  })
})
