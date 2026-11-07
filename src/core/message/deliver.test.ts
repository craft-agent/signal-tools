import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GROUP } from "../chat/read.testing"
import type { StoredChat } from "../chat/chat-rows"
import { failureOf } from "../signal/daemon.testing"
import { ALICE, BOB, GROUP_ID, ME } from "../signal/mirror.testing"
import { UNCERTAIN_MESSAGES, type DeliveryAction } from "./constants"
import { deliver, type DeliveryOptions } from "./deliver"
import type { PreparedChat } from "./prepare"
import { accepted, createSendFixture, failedEverywhere, recipientResult, SENT, type SendFixture } from "./send.testing"

let t: SendFixture

beforeEach(() => {
  t = createSendFixture()
})

afterEach(async () => {
  await t.close()
})

/** A chat as `prepareChat` hands it on. */
function preparedFor(id: string): PreparedChat {
  const chat: StoredChat = {
    id,
    kind: id.startsWith("group:") ? "group" : "person",
    name: null,
    number: null,
    member: 1,
    expires_in: null,
    last_ts: null,
  }
  return { chat, me: ME, noteToSelf: id === ME }
}

const ACTIONS: Record<string, DeliveryAction> = { send: "send", remoteDelete: "delete" }

/** Delivers `method` as the action that uses it, unless the options say otherwise. */
function run(
  prepared: PreparedChat,
  method: string,
  params: Record<string, unknown>,
  options: Partial<DeliveryOptions> = {},
) {
  return deliver(t.paths, prepared, method, params, { action: ACTIONS[method]!, ...options })
}

const METHODS: [string, Record<string, unknown>][] = [
  ["send", { message: "hello" }],
  ["remoteDelete", { targetTimestamp: 5000 }],
]

describe("the recipient", () => {
  test.each(METHODS)("%s to a person names the account id", async (method, params) => {
    await t.serve(accepted(ALICE))
    await run(preparedFor(ALICE), method, params)
    expect(t.daemon().calls).toEqual([{ method, params: { recipient: [ALICE], ...params } }])
  })

  test.each(METHODS)("%s to a group names its id without the prefix", async (method, params) => {
    await t.serve(accepted(ALICE))
    await run(preparedFor(GROUP), method, params)
    expect(t.daemon().calls).toEqual([{ method, params: { groupId: GROUP_ID, ...params } }])
  })

  test.each(METHODS)("%s to Note to Self is flagged as such", async (method, params) => {
    await t.serve({ result: { timestamp: SENT } })
    await run(preparedFor(ME), method, params)
    expect(t.daemon().calls).toEqual([{ method, params: { noteToSelf: true, ...params } }])
  })
})

describe("the outcome", () => {
  test.each(METHODS)("%s to Note to Self, answered with its time only, reached the user", async (method, params) => {
    await t.serve({ result: { timestamp: SENT } })
    expect(await run(preparedFor(ME), method, params)).toEqual({
      timestamp: SENT,
      delivered: [],
      delivered_count: 1,
      failed: [],
    })
  })

  test.each(METHODS)("%s to a group lists the members it did not reach", async (method, params) => {
    await t.serve({
      result: { timestamp: SENT, results: [recipientResult(ALICE), recipientResult(BOB, "UNREGISTERED_FAILURE")] },
    })
    expect(await run(preparedFor(GROUP), method, params)).toEqual({
      timestamp: SENT,
      delivered: [ALICE],
      delivered_count: 1,
      failed: [{ recipient: BOB, reason: "unregistered" }],
    })
  })

  test.each(METHODS)("%s that failed for everyone names the method in its error", async (method, params) => {
    await t.serve(failedEverywhere(-4, recipientResult(ALICE, "IDENTITY_FAILURE")))
    const error = await failureOf(run(preparedFor(ALICE), method, params))
    expect(error).toMatchObject({ code: "forbidden" })
    expect(error.message).toContain(method)
  })

  test.each(METHODS)("%s without a daemon asks to start the sync service", async (method, params) => {
    expect(await failureOf(run(preparedFor(ALICE), method, params))).toMatchObject({
      code: "upstream_error",
      message: "The Signal daemon is not running for this account; start its sync service.",
    })
  })
})

describe("an uncertain outcome says what the action may have done", () => {
  test("in the words of send, edit and delete", () => {
    expect(UNCERTAIN_MESSAGES).toEqual({
      send: "The message may have been sent. Check the chat on the phone before sending it again.",
      edit: "The edit may have gone out. Check the chat on the phone before editing again.",
      delete: "The message may have been deleted for everyone. Check the chat on the phone before deleting again.",
    })
  })

  test.each([
    ["send", "send", { message: "hello" }],
    ["edit", "send", { message: "hello", editTimestamp: 5000 }],
    ["delete", "remoteDelete", { targetTimestamp: 5000 }],
  ] as const)("%s answered in a form that cannot be read", async (action, method, params) => {
    await t.serve({ result: "done" })
    expect(await failureOf(deliver(t.paths, preparedFor(ALICE), method, params, { action }))).toMatchObject({
      code: "uncertain",
      message: UNCERTAIN_MESSAGES[action],
    })
  })

  test.each(["send", "edit", "delete"] as const)("%s whose connection closed without an answer", async (action) => {
    await t.serve("close")
    expect(await failureOf(deliver(t.paths, preparedFor(ALICE), "send", {}, { action }))).toMatchObject({
      code: "uncertain",
      message: UNCERTAIN_MESSAGES[action],
    })
  })
})

describe("the options", () => {
  test("a daemon that answers after the time limit leaves the request uncertain", async () => {
    await t.serve("hang")
    const error = await failureOf(run(preparedFor(ALICE), "remoteDelete", { targetTimestamp: 5000 }, { timeoutMs: 50 }))
    expect(error).toMatchObject({ code: "uncertain", message: UNCERTAIN_MESSAGES.delete })
  })

  test("a cancellation after the request was written is uncertain", async () => {
    await t.serve("hang")
    const controller = new AbortController()
    const pending = failureOf(run(preparedFor(ALICE), "send", { message: "hello" }, { signal: controller.signal }))
    while (t.daemon().calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    expect(await pending).toMatchObject({ code: "uncertain", message: UNCERTAIN_MESSAGES.send })
  })
})
