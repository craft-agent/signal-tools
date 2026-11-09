import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { callDescription } from "../describe"
import { MESSAGE_WORDS } from "../message/words"
import { upsertContacts } from "../signal/directory"
import { messageId } from "../signal/ids"
import { ALICE, dataFrom, ME, NOW, sentTo } from "../signal/mirror.testing"
import { signalFileSave } from "./save"
import { createSaveFixture, messageWithFiles, saveArgs, SENT, type SaveFixture } from "./save.testing"
import { FILE_WORDS } from "./words"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
  upsertContacts(t.mirror, [{ uuid: ALICE, name: "Alice" }], NOW)
  t.ingest(
    messageWithFiles(SENT, [
      { id: "a", filename: "one.txt" },
      { id: "b", filename: "two.zip" },
    ]),
  )
})

afterEach(() => {
  setSystemTime()
  t.close()
})

function describeCall(args: Record<string, unknown>) {
  return callDescription(signalFileSave, args, { cwd: t.stateDir, stateDir: t.stateDir })
}

describe("a person's message", () => {
  test("names the chat and the number of files, with no Chat fact and no From fact repeating the headline", async () => {
    expect(await describeCall(saveArgs())).toEqual({
      headline: { text: FILE_WORDS.saveHeadline, values: { chat: "Alice" } },
      facts: [{ label: "Files", value: { text: MESSAGE_WORDS.filesCount, values: { count: 2 } } }],
    })
  })

  test("says `1 file` for one file", async () => {
    t.ingest(messageWithFiles(SENT + 1, [{ id: "c", filename: "c.txt" }]))
    const description = await describeCall(saveArgs({ id: messageId(ALICE, SENT + 1) }))
    expect(description?.facts).toContainEqual({
      label: "Files",
      value: { text: MESSAGE_WORDS.file, values: { count: 1 } },
    })
  })

  test("adds the Unpack fact only when unpacking is asked for", async () => {
    const unpack = { label: FILE_WORDS.unpack, value: { text: FILE_WORDS.unpackValue } }
    expect((await describeCall(saveArgs({ unpack: true })))?.facts).toContainEqual(unpack)
    expect((await describeCall(saveArgs({ unpack: false })))?.facts).not.toContainEqual(unpack)
    expect((await describeCall(saveArgs()))?.facts).not.toContainEqual(unpack)
  })

  test("has no text and no pins", async () => {
    const description = await describeCall(saveArgs())
    expect(description).not.toHaveProperty("text")
    expect(description).not.toHaveProperty("pins")
  })
})

describe("the user's own message", () => {
  test("says the sender is you", async () => {
    t.ingest(sentTo(ALICE, SENT + 2, { message: "mine", attachments: [{ id: "m", filename: "m.txt" }] }))
    const description = await describeCall(saveArgs({ id: messageId(ME, SENT + 2) }))
    expect(description?.facts[0]).toEqual({ label: "From", value: { text: MESSAGE_WORDS.you } })
  })
})

describe("a call that would be refused", () => {
  test.each([
    [
      "a view-once message",
      () => dataFrom(ALICE, 20, { viewOnce: true, attachments: [{ id: "v", filename: "v.png" }] }),
      20,
    ],
    ["a message without files", () => dataFrom(ALICE, 21, { message: "no files" }), 21],
  ])("%s has no description", async (_name, payload, ts) => {
    t.ingest(payload())
    expect(await describeCall(saveArgs({ id: messageId(ALICE, ts) }))).toBeUndefined()
  })

  test.each([
    ["an unknown message", saveArgs({ id: messageId(ALICE, 99) })],
    ["an unknown chat", saveArgs({ chat: "nobody" })],
    ["an id that is not a message id", saveArgs({ id: "nope" })],
  ])("%s has no description", async (_name, args) => {
    expect(await describeCall(args)).toBeUndefined()
  })
})

describe("pinning", () => {
  test("the same call described twice, a moment apart, gives the same description", async () => {
    const args = saveArgs({ unpack: true })
    setSystemTime(new Date(1_800_000_000_000))
    const first = await describeCall(args)
    setSystemTime(new Date(1_800_000_060_000))
    expect(await describeCall(args)).toEqual(first)
    expect(first).toBeDefined()
  })
})
