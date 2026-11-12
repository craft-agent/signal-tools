import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { GROUP } from "./core/chat/read.testing"
import { signalFileSave } from "./core/file/save"
import { createSaveFixture, messageWithFiles, saveArgs, SENT, type SaveFixture } from "./core/file/save.testing"
import { signalFileSend } from "./core/file/send/tool"
import { createFileSendFixture } from "./core/file/send/tool.testing"
import { upsertContacts } from "./core/signal/directory"
import { messageId } from "./core/signal/ids"
import { ALICE, NOW } from "./core/signal/mirror.testing"
import { promptTime } from "./core/time"
import { promptOf, withPlaceholders } from "./prompts.testing"

const lines = (...parts: string[]) => parts.join("\n")

const TARGET_ALICE = `default/${ALICE}`
const TARGET_GROUP = `default/${GROUP}`

describe("the approval prompt of signal_file_send", () => {
  const f = createFileSendFixture()
  const ctx = { cwd: f.work, stateDir: f.stateDir }
  const prompt = async (args: Record<string, unknown>, language?: string) =>
    withPlaceholders(await promptOf(signalFileSend, args, ctx, language), { "<work>": f.work })

  beforeAll(() => {
    f.write("report.pdf", "x".repeat(2048))
    f.write("a.txt", "a")
  })

  afterAll(async () => {
    await f.close()
  })

  const one = { chat: ALICE, files: [{ path: "report.pdf" }], text: "Q3 report" }
  const several = { chat: GROUP, files: [{ path: "report.pdf" }, { path: "a.txt" }] }

  test("one file to a person with a caption, in English", async () => {
    expect(await prompt(one)).toBe(
      lines(
        'About to send "report.pdf" to "Alice"',
        "",
        "--- Details ---",
        "",
        "Target: <work>/report.pdf",
        `Target: ${TARGET_ALICE}`,
        "Chat: Person",
        "Size: 2048 bytes",
        "",
        "--- Caption ---",
        "",
        "Q3 report",
      ),
    )
  })

  test("one file to a person with a caption, in Japanese", async () => {
    expect(await prompt(one, "ja")).toBe(
      lines(
        '"Alice" に "report.pdf" を送信しようとしています',
        "",
        "--- 詳細 ---",
        "",
        "対象: <work>/report.pdf",
        `対象: ${TARGET_ALICE}`,
        "チャット: 個人",
        "サイズ: 2048 バイト",
        "",
        "--- キャプション ---",
        "",
        "Q3 report",
      ),
    )
  })

  test("several files to a group, in English", async () => {
    expect(await prompt(several)).toBe(
      lines(
        'About to send files to "Team"',
        "",
        "--- Details ---",
        "",
        "Target: <work>/a.txt",
        "Target: <work>/report.pdf",
        `Target: ${TARGET_GROUP}`,
        "Chat: Group",
        "Members: 1 member",
        "Files: 2 files",
        "Size: 2049 bytes",
      ),
    )
  })

  test("several files to a group, in Japanese", async () => {
    expect(await prompt(several, "ja")).toBe(
      lines(
        '"Team" にファイルを送信しようとしています',
        "",
        "--- 詳細 ---",
        "",
        "対象: <work>/a.txt",
        "対象: <work>/report.pdf",
        `対象: ${TARGET_GROUP}`,
        "チャット: グループ",
        "メンバー: 1 人",
        "ファイル: 2 個",
        "サイズ: 2049 バイト",
      ),
    )
  })

  test("a group reply to another member with a file, in English", async () => {
    expect(await prompt({ chat: GROUP, files: [{ path: "report.pdf" }], reply_to: messageId(ALICE, 2000) })).toBe(
      lines(
        'About to reply to "Alice" in "Team" with "report.pdf"',
        "",
        "--- Details ---",
        "",
        "Target: <work>/report.pdf",
        `Target: ${TARGET_GROUP}`,
        "Chat: Group",
        `Reply to: ${promptTime(2000)} "hello team"`,
        "Members: 1 member",
        "Size: 2048 bytes",
      ),
    )
  })

  test("a group reply to another member with a file, in Japanese", async () => {
    expect(await prompt({ chat: GROUP, files: [{ path: "report.pdf" }], reply_to: messageId(ALICE, 2000) }, "ja")).toBe(
      lines(
        '"Team" で "Alice" に "report.pdf" を付けて返信しようとしています',
        "",
        "--- 詳細 ---",
        "",
        "対象: <work>/report.pdf",
        `対象: ${TARGET_GROUP}`,
        "チャット: グループ",
        `返信先: ${promptTime(2000)}「hello team」`,
        "メンバー: 1 人",
        "サイズ: 2048 バイト",
      ),
    )
  })
})

describe("the approval prompt of signal_file_save", () => {
  let t: SaveFixture
  const prompt = (language?: string) =>
    promptOf(signalFileSave, saveArgs(), { cwd: t.stateDir, stateDir: t.stateDir }, language)

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

  test("a message with two files, in English", async () => {
    expect(await prompt()).toBe(lines('About to save files from "Alice"', "", "--- Details ---", "", "Files: 2 files"))
  })

  test("a message with two files, in Japanese", async () => {
    expect(await prompt("ja")).toBe(
      lines('"Alice" のメッセージのファイルを保存しようとしています', "", "--- 詳細 ---", "", "ファイル: 2 個"),
    )
  })
})
