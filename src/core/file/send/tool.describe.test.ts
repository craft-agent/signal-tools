import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GROUP } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { MAX_TEXT_CHARACTERS } from "../../message/constants"
import { MESSAGE_WORDS } from "../../message/words"
import { messageId } from "../../signal/ids"
import { ALICE, GROUP_ID, ME } from "../../signal/mirror.testing"
import { FILE_WORDS } from "../words"
import { signalFileSend } from "./tool"
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
      pins: { [`sha256:${first}`]: sha256Of("abc"), [`sha256:${second}`]: sha256Of("defgh") },
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
  })
})

describe("a call that would be refused", () => {
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
