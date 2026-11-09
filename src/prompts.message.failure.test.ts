import { afterAll, describe, expect, test } from "bun:test"
import { createActionFixture } from "./core/message/action.testing"
import { signalMessageSend } from "./core/message/send"
import { ALICE } from "./core/signal/mirror.testing"
import type { ToolSpec } from "./core"
import { promptOf } from "./prompts.testing"

const t = createActionFixture()
const ctx = { cwd: t.stateDir, stateDir: t.stateDir }

const TARGET_ALICE = `default/${ALICE}`
const UNKNOWN_CHAT = "99999999-9999-4999-8999-999999999999"

const lines = (...parts: string[]) => parts.join("\n")

afterAll(async () => {
  await t.close()
})

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
