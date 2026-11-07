import { afterEach, beforeEach, expect, test } from "bun:test"
import { ALICE, BOB, GROUP_ID, ME } from "../signal/mirror.testing"
import { formatLocalTime } from "../time"
import { GROUP } from "../chat/read.testing"
import { accepted, createSendFixture, failedEverywhere, recipientResult, SENT, type SendFixture } from "./send.testing"

let t: SendFixture

beforeEach(() => {
  t = createSendFixture()
})

afterEach(async () => {
  await t.close()
})

test("sends to a person by account id and returns the id and time", async () => {
  await t.serve(accepted(ALICE))
  const result = await t.send({ chat: ALICE, text: "hello" })
  expect(result).toEqual({ id: `${ME}:${SENT}`, chat: ALICE, time: formatLocalTime(SENT) })
  expect(t.sentParams()).toEqual({ recipient: [ALICE], message: "hello" })
})

test("sends to Note to Self with the flag, from an answer with the timestamp only", async () => {
  await t.serve({ result: { timestamp: SENT } })
  const result = await t.send({ chat: ME, text: "remember" })
  expect(result).toEqual({ id: `${ME}:${SENT}`, chat: ME, time: formatLocalTime(SENT) })
  expect(t.sentParams()).toEqual({ noteToSelf: true, message: "remember" })
})

test("sends to Note to Self when signal-cli lists no recipients", async () => {
  await t.serve({ result: { timestamp: SENT, results: [] } })
  expect((await t.send({ chat: ME, text: "remember" })).id).toBe(`${ME}:${SENT}`)
})

test("a group is sent by its id without the prefix and reports how many members it reached", async () => {
  await t.serve(accepted(ALICE, BOB))
  const result = await t.send({ chat: GROUP, text: "hello team" })
  expect(result).toEqual({ id: `${ME}:${SENT}`, chat: GROUP, time: formatLocalTime(SENT), reached: 2 })
  expect(t.sentParams()).toEqual({ groupId: GROUP_ID, message: "hello team" })
})

test("a group send that missed some members lists them by id with plain reasons and no number", async () => {
  await t.serve({
    result: {
      timestamp: SENT,
      results: [
        recipientResult(ALICE),
        recipientResult(BOB, "UNREGISTERED_FAILURE"),
        { recipientAddress: { number: "+15555550123" }, type: "IDENTITY_FAILURE" },
        recipientResult(ALICE.replace(/2/g, "5"), "RATE_LIMIT_FAILURE", { retryAfterSeconds: 30 }),
        recipientResult(ALICE.replace(/2/g, "6"), "NETWORK_FAILURE"),
      ],
    },
  })
  const result = await t.send({ chat: GROUP, text: "hello team" })
  expect(result.reached).toBe(1)
  expect(result.not_reached).toEqual([
    { id: BOB, reason: "not on Signal" },
    { reason: "safety number changed; verify it on the phone" },
    { id: ALICE.replace(/2/g, "5"), reason: "Signal rate-limited the send; try again in 30 seconds" },
    { id: ALICE.replace(/2/g, "6"), reason: "network failure; it may still arrive" },
  ])
  expect(JSON.stringify(result)).not.toContain("+1555")
})

test("a person's send with a failure entry beside a success reports reached and not_reached", async () => {
  await t.serve({
    result: { timestamp: SENT, results: [recipientResult(ALICE), recipientResult(BOB, "UNREGISTERED_FAILURE")] },
  })
  const result = await t.send({ chat: ALICE, text: "hello" })
  expect(result).toMatchObject({ reached: 1, not_reached: [{ id: BOB, reason: "not on Signal" }] })
})

test("a group where nobody was reached fails by the reasons, as an error whose data carries the results", async () => {
  await t.serve(
    failedEverywhere(-1, recipientResult(ALICE, "UNREGISTERED_FAILURE"), recipientResult(BOB, "UNREGISTERED_FAILURE")),
  )
  await expect(t.send({ chat: GROUP, text: "hi" })).rejects.toMatchObject({ code: "not_found" })
})

test("all identity failures are forbidden", async () => {
  await t.serve(failedEverywhere(-4, recipientResult(ALICE, "IDENTITY_FAILURE")))
  const error = await t.sendFailure({ chat: ALICE, text: "hi" })
  expect(error).toMatchObject({ code: "forbidden" })
  expect(error.message).toContain("safety number")
})

test("all rate limits are rate_limited, with the wait Signal asked for", async () => {
  await t.serve(failedEverywhere(-5, recipientResult(ALICE, "RATE_LIMIT_FAILURE", { retryAfterSeconds: 90 })))
  const error = await t.sendFailure({ chat: ALICE, text: "hi" })
  expect(error).toMatchObject({ code: "rate_limited" })
  expect(error.message).toContain("90 seconds")
})

test("any network or unknown failure among those that failed is uncertain", async () => {
  await t.serve(
    failedEverywhere(-1, recipientResult(ALICE, "UNREGISTERED_FAILURE"), recipientResult(BOB, "NETWORK_FAILURE")),
  )
  await expect(t.send({ chat: GROUP, text: "hi" })).rejects.toMatchObject({ code: "uncertain" })
})

test("a failed call whose results include a success is a send that reached someone", async () => {
  await t.serve(failedEverywhere(-1, recipientResult(ALICE), recipientResult(BOB, "NETWORK_FAILURE")))
  const result = await t.send({ chat: GROUP, text: "hi" })
  expect(result).toMatchObject({ reached: 1, not_reached: [{ id: BOB }] })
})
