import { describe, expect, test } from "bun:test"
import { cutMessage, dropMetadata, messageTextLength } from "./message-cut"
import type { MessageEntry } from "./message-schema"

const TIME = "2026-11-07T14:03:12.345+09:00"

const full: MessageEntry = {
  id: "a:1",
  time: TIME,
  from: "Alice",
  text: "1234",
  files: [{ name: "f.txt", caption: "cc" }, { name: "g.txt" }],
  reply_to: { id: null, text: "qqq" },
  earlier_versions: [{ time: TIME, text: "vvvvv" }],
  reactions: [{ from: "me", emoji: "👍" }],
}

describe("cutMessage", () => {
  test("counts the text, captions, quoted text and earlier versions", () => {
    expect(messageTextLength(full)).toBe(4 + 2 + 3 + 5)
  })

  test("keeps the text first, then captions, the quote and the earlier versions", () => {
    const cut = cutMessage(full, 7)
    expect(cut.text).toBe("1234")
    expect(cut.files?.[0]?.caption).toBe("cc")
    expect(cut.reply_to?.text).toBe("q")
    expect(cut.earlier_versions?.[0]?.text).toBe("")
    expect(cut.text_cut).toBe(true)
    expect(cutMessage(full, 3).text).toBe("123")
  })

  test("marks nothing when nothing is lost, and cuts no pair of surrogates in two", () => {
    expect(cutMessage(full, 100)).toEqual(full)
    expect(cutMessage({ ...full, text: "a😀b" }, 2).text).toBe("a")
  })
})

describe("dropMetadata", () => {
  test("drops earlier versions, then reactions, then files, counting the files", () => {
    const first = dropMetadata(full)
    expect(first).not.toHaveProperty("earlier_versions")
    expect(first).toMatchObject({ text_cut: true, omitted: ["earlier_versions"], text: "1234" })
    expect(first?.reactions).toBeDefined()
    const second = dropMetadata(first!)
    expect(second).not.toHaveProperty("reactions")
    expect(second?.omitted).toEqual(["earlier_versions", "reactions"])
    const third = dropMetadata(second!)
    expect(third).not.toHaveProperty("files")
    expect(third).toMatchObject({ files_omitted: 2, omitted: ["earlier_versions", "reactions", "files"] })
    expect(dropMetadata(third!)).toBeNull()
  })

  test("skips what a message does not have, and leaves the original alone", () => {
    const plain: MessageEntry = { id: "a:1", time: TIME, from: "me", text: "x", files: [{}] }
    expect(dropMetadata(plain)).toMatchObject({ files_omitted: 1, omitted: ["files"] })
    expect(plain.files).toEqual([{}])
    expect(dropMetadata({ id: "a:1", time: TIME, from: "me", text: "x" })).toBeNull()
  })
})
