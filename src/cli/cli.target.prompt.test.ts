import { afterAll, expect, test } from "bun:test"
import { signalMessageSend } from "../core/message/send"
import { createSendFixture } from "../core/message/send.testing"
import { ALICE } from "../core/signal/mirror.testing"
import { ALL_TRANSLATIONS } from "../words"
import { EXIT_OK } from "./cli"
import { cli, json } from "./testing"

const t = createSendFixture()

afterAll(async () => {
  await t.close()
})

test("target for a message send in Japanese gives the headline, facts and text label in Japanese", async () => {
  const run = await cli(
    ["target", signalMessageSend.id, "--cwd", t.stateDir, "--state-dir", t.stateDir, "--language", "ja"],
    JSON.stringify({ chat: ALICE, text: "hello" }),
    { specs: [signalMessageSend], translations: ALL_TRANSLATIONS },
  )
  expect(run.code).toBe(EXIT_OK)
  const answer = json(run)
  expect(answer.description).toEqual({
    headline: '"Alice" にメッセージを送信しようとしています',
    facts: [{ label: "チャット", value: "個人" }],
    text: { label: "メッセージの本文", body: "hello" },
  })
  expect(answer.words).toMatchObject({ details: "詳細", target: "対象", more: "（ほか {count} 件）" })
})
