import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { GROUP } from "./core/chat/read.testing"
import { AT, createActionFixture, OWN, reactionData } from "./core/message/action.testing"
import { signalMessageDelete } from "./core/message/delete"
import { signalMessageEdit } from "./core/message/edit"
import { signalMessageReact } from "./core/message/react"
import { signalMessageSend } from "./core/message/send"
import { messageId } from "./core/signal/ids"
import { ALICE, ME } from "./core/signal/mirror.testing"
import type { ToolSpec } from "./core"
import { promptOf } from "./prompts.testing"

const t = createActionFixture()
const ctx = { cwd: t.stateDir, stateDir: t.stateDir }

const NOTE = OWN + 10
const REACTED = messageId(ALICE, 5000)
const TARGET_ALICE = `default/${ALICE}`
const TARGET_ME = `default/${ME}`
const TARGET_GROUP = `default/${GROUP}`
const TARGET_OWN = `${TARGET_ALICE}/${messageId(ME, OWN)}`
const TARGET_NOTE = `${TARGET_ME}/${messageId(ME, NOTE)}`
const TARGET_REACTED = `${TARGET_ALICE}/${REACTED}`

const lines = (...parts: string[]) => parts.join("\n")

beforeAll(() => {
  setSystemTime(new Date(AT))
  t.ownMessage(OWN, { message: "see you at 6" })
  t.ownMessage(NOTE, { message: "note to me" }, ME)
  t.ownMessage(OWN + 500, reactionData(ALICE, 5000, "❤️"))
})

afterAll(async () => {
  setSystemTime()
  await t.close()
})

type Case = {
  name: string
  spec: ToolSpec
  args: Record<string, unknown>
  en: string
  ja: string
}

const CASES: Case[] = [
  {
    name: "send to a person, replying and with the text trimmed",
    spec: signalMessageSend,
    args: { chat: ALICE, text: " Running late, 10 min. ", reply_to: REACTED },
    en: lines(
      'About to send a message to "Alice"',
      "",
      "--- Details ---",
      "",
      `Target: ${TARGET_ALICE}`,
      "Chat: Person",
      "Reply to: hello from Alice",
      "",
      "--- Message text ---",
      "",
      "Running late, 10 min.",
    ),
    ja: lines(
      '"Alice" にメッセージを送信しようとしています',
      "",
      "--- 詳細 ---",
      "",
      `対象: ${TARGET_ALICE}`,
      "チャット: 個人",
      "返信先: hello from Alice",
      "",
      "--- メッセージの本文 ---",
      "",
      "Running late, 10 min.",
    ),
  },
  {
    name: "send to a group",
    spec: signalMessageSend,
    args: { chat: GROUP, text: "hi all" },
    en: lines(
      'About to send a message to "Team"',
      "",
      "--- Details ---",
      "",
      `Target: ${TARGET_GROUP}`,
      "Chat: Group",
      "Members: 1 member",
      "",
      "--- Message text ---",
      "",
      "hi all",
    ),
    ja: lines(
      '"Team" にメッセージを送信しようとしています',
      "",
      "--- 詳細 ---",
      "",
      `対象: ${TARGET_GROUP}`,
      "チャット: グループ",
      "メンバー: 1 人",
      "",
      "--- メッセージの本文 ---",
      "",
      "hi all",
    ),
  },
  {
    name: "send to Note to Self",
    spec: signalMessageSend,
    args: { chat: ME, text: "buy milk" },
    en: lines(
      "About to send a message to Note to Self",
      "",
      "--- Details ---",
      "",
      `Target: ${TARGET_ME}`,
      "",
      "--- Message text ---",
      "",
      "buy milk",
    ),
    ja: lines(
      "自分用メモにメッセージを送信しようとしています",
      "",
      "--- 詳細 ---",
      "",
      `対象: ${TARGET_ME}`,
      "",
      "--- メッセージの本文 ---",
      "",
      "buy milk",
    ),
  },
  {
    name: "edit",
    spec: signalMessageEdit,
    args: { chat: ALICE, id: messageId(ME, OWN), text: "see you at 7" },
    en: lines(
      'About to edit your message in "Alice"',
      "",
      "--- Details ---",
      "",
      `Target: ${TARGET_OWN}`,
      "Chat: Person",
      "Current: see you at 6",
      "",
      "--- New text ---",
      "",
      "see you at 7",
    ),
    ja: lines(
      '"Alice" の自分のメッセージを編集しようとしています',
      "",
      "--- 詳細 ---",
      "",
      `対象: ${TARGET_OWN}`,
      "チャット: 個人",
      "現在の本文: see you at 6",
      "",
      "--- 新しい本文 ---",
      "",
      "see you at 7",
    ),
  },
  {
    name: "delete in a person's chat",
    spec: signalMessageDelete,
    args: { chat: ALICE, id: messageId(ME, OWN) },
    en: lines(
      'About to delete your message in "Alice" for everyone',
      "",
      "--- Details ---",
      "",
      `Target: ${TARGET_OWN}`,
      "Chat: Person",
      "Message: see you at 6",
    ),
    ja: lines(
      '"Alice" の自分のメッセージを全員から削除しようとしています',
      "",
      "--- 詳細 ---",
      "",
      `対象: ${TARGET_OWN}`,
      "チャット: 個人",
      "メッセージ: see you at 6",
    ),
  },
  {
    name: "delete in Note to Self",
    spec: signalMessageDelete,
    args: { chat: ME, id: messageId(ME, NOTE) },
    en: lines(
      "About to delete your message in Note to Self on every device",
      "",
      "--- Details ---",
      "",
      `Target: ${TARGET_NOTE}`,
      "Message: note to me",
    ),
    ja: lines(
      "自分用メモのメッセージをすべての端末から削除しようとしています",
      "",
      "--- 詳細 ---",
      "",
      `対象: ${TARGET_NOTE}`,
      "メッセージ: note to me",
    ),
  },
  {
    name: "react over an earlier reaction",
    spec: signalMessageReact,
    args: { chat: ALICE, id: REACTED, emoji: "👍" },
    en: lines(
      'About to react with "👍" in "Alice"',
      "",
      "--- Details ---",
      "",
      `Target: ${TARGET_REACTED}`,
      "Chat: Person",
      "Replaces: ❤<U+FE0F>",
      "From: Alice",
      "Message: hello from Alice",
    ),
    ja: lines(
      '"Alice" で "👍" のリアクションを付けようとしています',
      "",
      "--- 詳細 ---",
      "",
      `対象: ${TARGET_REACTED}`,
      "チャット: 個人",
      "今のリアクション: ❤<U+FE0F>",
      "送信者: Alice",
      "メッセージ: hello from Alice",
    ),
  },
  {
    name: "remove a reaction",
    spec: signalMessageReact,
    args: { chat: ALICE, id: REACTED, remove: true },
    en: lines(
      'About to remove your "❤<U+FE0F>" reaction in "Alice"',
      "",
      "--- Details ---",
      "",
      `Target: ${TARGET_REACTED}`,
      "Chat: Person",
      "From: Alice",
      "Message: hello from Alice",
    ),
    ja: lines(
      '"Alice" で付けた "❤<U+FE0F>" のリアクションを取り消そうとしています',
      "",
      "--- 詳細 ---",
      "",
      `対象: ${TARGET_REACTED}`,
      "チャット: 個人",
      "送信者: Alice",
      "メッセージ: hello from Alice",
    ),
  },
]

describe("the approval prompt of a message tool", () => {
  test.each(CASES)("$name, in English", async ({ spec, args, en }) => {
    expect(await promptOf(spec, args, ctx)).toBe(en)
  })

  test.each(CASES)("$name, in Japanese", async ({ spec, args, ja }) => {
    expect(await promptOf(spec, args, ctx, "ja")).toBe(ja)
  })
})

const UNKNOWN_CHAT = "99999999-9999-4999-8999-999999999999"

describe("a description that fails still gives the prompt", () => {
  const args = { chat: UNKNOWN_CHAT, text: "hello" }
  const target = `default/${UNKNOWN_CHAT}`

  test("an unknown chat gives the intent alone with its target", async () => {
    expect(await promptOf(signalMessageSend, args, ctx)).toBe(
      lines("About to send a message", "", "--- Details ---", "", `Target: ${target}`),
    )
    expect(await promptOf(signalMessageSend, args, ctx, "ja")).toBe(
      lines("メッセージを送信しようとしています", "", "--- 詳細 ---", "", `対象: ${target}`),
    )
  })

  test("a describer that never answers within the timeout gives the intent alone with its target", async () => {
    const hanging: ToolSpec = {
      ...signalMessageSend,
      describe: (_args, { signal }) =>
        new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
    }
    const sent = { chat: ALICE, text: "hello" }
    expect(await promptOf(hanging, sent, ctx, undefined, 20)).toBe(
      lines("About to send a message", "", "--- Details ---", "", `Target: ${TARGET_ALICE}`),
    )
    expect(await promptOf(hanging, sent, ctx, "ja", 20)).toBe(
      lines("メッセージを送信しようとしています", "", "--- 詳細 ---", "", `対象: ${TARGET_ALICE}`),
    )
  })
})
