import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE } from "../signal/mirror.testing"
import { accepted, createSendFixture, failedEverywhere, recipientResult, SENT, type SendFixture } from "./send.testing"

const UNCERTAIN = "The message may have been sent. Check the chat on the phone before sending it again."

let t: SendFixture

beforeEach(() => {
  t = createSendFixture()
})

afterEach(async () => {
  await t.close()
})

const send = () => t.sendFailure({ chat: ALICE, text: "hello" })

/** Nothing of the message may be in the mirror after a send that failed or may have failed. */
function expectNoRecord(): void {
  expect(t.mirror.prepare("SELECT 1 FROM messages WHERE body = 'hello'").get()).toBeUndefined()
}

describe("before anything is sent", () => {
  test("a daemon that is not running asks to start the sync service", async () => {
    const error = await send()
    expect(error).toMatchObject({
      code: "upstream_error",
      message: "The Signal daemon is not running for this account; start its sync service.",
    })
    expectNoRecord()
  })

  test("invalid params keep their code", async () => {
    await t.serve({ error: { code: -32602, message: "Invalid params" } })
    expect(await send()).toMatchObject({ code: "invalid_argument" })
    expectNoRecord()
  })

  test("a rate limit keeps its code", async () => {
    await t.serve({ error: { code: -5, message: "Rate limited" } })
    expect(await send()).toMatchObject({ code: "rate_limited" })
  })

  test("an untrusted identity is forbidden", async () => {
    await t.serve({ error: { code: -4, message: "Untrusted identity" } })
    expect(await send()).toMatchObject({ code: "forbidden" })
  })

  test("an error whose data holds no results stands for its code", async () => {
    await t.serve({ error: { code: -5, message: "Rate limited", data: { response: { timestamp: 1, results: [] } } } })
    expect(await send()).toMatchObject({ code: "rate_limited" })
  })

  test("an error with no data, or a response without results, stands for its code", async () => {
    await t.serve({ error: { code: -5, message: "Rate limited" } })
    expect(await send()).toMatchObject({ code: "rate_limited" })
    await t.serve({ error: { code: -5, message: "Rate limited", data: { response: { timestamp: SENT } } } })
    expect(await send()).toMatchObject({ code: "rate_limited" })
  })

  test("an error whose results are all rate limits is rate_limited by them", async () => {
    await t.serve(failedEverywhere(-5, recipientResult(ALICE, "RATE_LIMIT_FAILURE")))
    expect(await send()).toMatchObject({ code: "rate_limited" })
  })

  test("a cancellation before the call starts is not turned into uncertain", async () => {
    await t.serve(accepted(ALICE))
    const controller = new AbortController()
    controller.abort()
    const error = await t.sendFailure({ chat: ALICE, text: "hello" }, { signal: controller.signal })
    expect(error.name).toBe("AbortError")
    expect(t.daemon().calls).toEqual([])
  })
})

describe("an error whose results are there but cannot be read is uncertain, whatever its code", () => {
  const response = (results: unknown, timestamp: number | null = SENT) => ({
    error: { code: -5, message: "Rate limited", data: { response: { timestamp, results } } },
  })

  test.each([
    ["a success beside a malformed entry", response([recipientResult(ALICE), "garbage"])],
    ["a success and no timestamp", response([recipientResult(ALICE)], null)],
    ["results that are not a list", response("no")],
    ["an unknown type and no success", failedEverywhere(-1, recipientResult(ALICE, "SOMETHING_NEW"))],
  ])("%s", async (_name, reply) => {
    await t.serve(reply)
    expect(await send()).toMatchObject({ code: "uncertain", message: UNCERTAIN })
    expectNoRecord()
  })
})

describe("after the request was written", () => {
  test("a call cancelled while waiting is uncertain, saying to check the phone", async () => {
    await t.serve("hang")
    const controller = new AbortController()
    const pending = t.sendFailure({ chat: ALICE, text: "hello" }, { signal: controller.signal })
    while (t.daemon().calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    expect(await pending).toMatchObject({ code: "uncertain", message: UNCERTAIN })
    expectNoRecord()
  })

  test("a connection closed without an answer is uncertain", async () => {
    await t.serve("close")
    expect(await send()).toMatchObject({ code: "uncertain", message: UNCERTAIN })
    expectNoRecord()
  })

  test("an unknown error code is uncertain", async () => {
    await t.serve({ error: { code: -3, message: "I/O failure" } })
    expect(await send()).toMatchObject({ code: "uncertain", message: UNCERTAIN })
  })

  test.each([
    ["without a timestamp", { results: [recipientResult(ALICE)] }],
    ["with a timestamp that is not a time", { timestamp: 0, results: [recipientResult(ALICE)] }],
    ["in a form that cannot be read", "sent"],
    ["without recipients", { timestamp: 1_800_000_100_000, results: [] }],
  ])("a success %s is uncertain", async (_name, result) => {
    await t.serve({ result })
    expect(await send()).toMatchObject({ code: "uncertain", message: UNCERTAIN })
    expectNoRecord()
  })
})
