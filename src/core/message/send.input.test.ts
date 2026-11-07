import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { OTHER_GROUP } from "../chat/read.testing"
import { ALICE, BOB } from "../signal/mirror.testing"
import { labelPaths } from "../signal/labels"
import { writeTargets } from "../targets"
import { annotations } from "../tool"
import { accepted, createSendFixture, type SendFixture } from "./send.testing"
import { signalMessageSend } from "./send"

let t: SendFixture

beforeEach(async () => {
  t = createSendFixture()
  await t.serve(accepted(ALICE))
})

afterEach(async () => {
  await t.close()
})

describe("the text", () => {
  test("is trimmed before it is sent", async () => {
    await t.send({ chat: ALICE, text: " \n  hello  there \t\n" })
    expect(t.sentParams()).toMatchObject({ message: "hello  there" })
  })

  test("4,000 characters are sent, counting an emoji as one", async () => {
    const text = "😀".repeat(2000) + "a".repeat(2000)
    expect(text.length).toBe(6000)
    await t.send({ chat: ALICE, text: ` ${text} ` })
    expect(t.sentParams()).toMatchObject({ message: text })
  })

  test("4,001 characters are refused before anything is sent", async () => {
    const error = await t.sendFailure({ chat: ALICE, text: "😀".repeat(4001) })
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(error.message).toContain("4001")
    expect(t.daemon().calls).toEqual([])
  })

  test.each(["", "   ", "\n\t \n"])("blank text %j is refused", async (text) => {
    await expect(t.send({ chat: ALICE, text })).rejects.toMatchObject({ code: "invalid_argument" })
    expect(t.daemon().calls).toEqual([])
  })

  test("arguments the tool does not take are refused", async () => {
    await expect(t.send({ chat: ALICE, text: "x", files: [] })).rejects.toMatchObject({ code: "invalid_argument" })
  })
})

describe("the chat", () => {
  test("an unknown chat is not_found and nothing is sent", async () => {
    await expect(t.send({ chat: BOB.replace(/3/g, "7"), text: "x" })).rejects.toMatchObject({
      code: "not_found",
      message: "No chat with this id in this account's mirror.",
    })
    expect(t.daemon().calls).toEqual([])
  })

  test.each(["Alice", "+15555550123", "group:short"])("%j is not a chat id", async (chat) => {
    await expect(t.send({ chat, text: "x" })).rejects.toMatchObject({ code: "invalid_argument" })
  })

  test("a group the user left is forbidden and nothing is sent", async () => {
    const error = await t.sendFailure({ chat: OTHER_GROUP, text: "x" })
    expect(error).toMatchObject({ code: "forbidden", message: "You left this group; you can no longer send to it." })
    expect(t.daemon().calls).toEqual([])
  })

  test("a mirror that does not know the user's own id yet cannot be sent from", async () => {
    t.mirror.exec("DELETE FROM meta WHERE key = 'account_uuid'")
    await expect(t.send({ chat: ALICE, text: "x" })).rejects.toMatchObject({ code: "upstream_error" })
    expect(t.daemon().calls).toEqual([])
  })

  test("an account that is not linked is not_found", async () => {
    await expect(t.send({ account: "other", chat: ALICE, text: "x" })).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("targets", () => {
  const targets = (args: Record<string, unknown>, stateDir = t.stateDir) =>
    writeTargets(signalMessageSend, args, { cwd: stateDir, stateDir })

  test("name the label and the chat", async () => {
    expect(await targets({ chat: ALICE, text: "x" })).toEqual([`default/${ALICE}`])
    expect(await targets({ account: "default", chat: "group:abc", text: "x" })).toEqual(["default/group:abc"])
  })

  test("are any when the label cannot be resolved", async () => {
    expect(await targets({ account: "nobody", chat: ALICE, text: "x" })).toEqual(["*"])
    mkdirSync(labelPaths(t.stateDir, "second").dir)
    expect(await targets({ chat: ALICE, text: "x" })).toEqual(["*"])
  })

  test("are any without a state directory", async () => {
    expect(await writeTargets(signalMessageSend, { chat: ALICE, text: "x" }, { cwd: t.stateDir })).toEqual(["*"])
  })

  test("are any when the chat holds a wildcard", async () => {
    expect(await targets({ chat: "group:*", text: "x" })).toEqual(["*"])
    expect(await targets({ chat: "a?b", text: "x" })).toEqual(["*"])
  })

  test("are any for arguments the schema refuses", async () => {
    expect(await targets({ chat: ALICE })).toEqual(["*"])
  })
})

test("the tool is an add in the sends toolset", () => {
  expect(signalMessageSend).toMatchObject({ id: "signal_message_send", toolset: "sends", class: "add" })
  expect(annotations(signalMessageSend)).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  })
})
