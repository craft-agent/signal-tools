import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { readSendResults, sendOutcome } from "./daemon-results"

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"
const NUMBER = "+15555550123"

type Entry = { uuid?: string; number?: string; type: string; retryAfterSeconds?: number }

function sendResult(...entries: Entry[]) {
  return {
    timestamp: 1700000000000,
    results: entries.map(({ uuid, number, type, retryAfterSeconds }) => ({
      recipientAddress: { uuid, number },
      type,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    })),
  }
}

function outcomeError(...entries: Entry[]): ToolError {
  try {
    sendOutcome(readSendResults(sendResult(...entries), "send"), "send")
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("expected sendOutcome to throw")
}

describe("readSendResults", () => {
  test("reads a delivery to one recipient", () => {
    expect(readSendResults(sendResult({ uuid: ALICE, number: NUMBER, type: "SUCCESS" }), "send")).toEqual({
      timestamp: 1700000000000,
      delivered: [ALICE],
      delivered_count: 1,
      failed: [],
    })
  })

  test("lists the members of a group that were not reached", () => {
    const results = readSendResults(
      sendResult(
        { uuid: ALICE, type: "SUCCESS" },
        { uuid: BOB, type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 30 },
        { number: NUMBER, type: "UNREGISTERED_FAILURE" },
      ),
      "send",
    )
    expect(results.delivered).toEqual([ALICE])
    expect(results.failed).toEqual([
      { recipient: BOB, reason: "rate_limit", retry_after_seconds: 30 },
      { recipient: null, reason: "unregistered" },
    ])
  })

  test("counts a recipient without an account id as delivered, and never lists its number", () => {
    const results = readSendResults(sendResult({ number: NUMBER, type: "SUCCESS" }), "send")
    expect(results.delivered).toEqual([])
    expect(results.delivered_count).toBe(1)
    expect(JSON.stringify(results)).not.toContain(NUMBER)
  })

  test("keeps a uuid field only when it is a UUID, whatever its case", () => {
    const upper = ALICE.toUpperCase()
    const results = readSendResults(sendResult({ uuid: upper, type: "SUCCESS" }), "send")
    expect(results.delivered).toEqual([upper])
  })

  test("never passes on a uuid field that holds something else, such as a number", () => {
    for (const uuid of [NUMBER, "+1 555 555 0123", "not-a-uuid", `${ALICE}x`, ` ${ALICE}`, ""]) {
      const results = readSendResults(
        sendResult({ uuid, type: "SUCCESS" }, { uuid, type: "UNREGISTERED_FAILURE" }),
        "send",
      )
      expect(results.delivered).toEqual([])
      expect(results.delivered_count).toBe(1)
      expect(results.failed).toEqual([{ recipient: null, reason: "unregistered" }])
      expect(JSON.stringify(results)).not.toContain("555")
    }
  })

  test("maps every failure type, and an unlisted one to unknown", () => {
    const types = [
      ["UNREGISTERED_FAILURE", "unregistered"],
      ["IDENTITY_FAILURE", "identity"],
      ["RATE_LIMIT_FAILURE", "rate_limit"],
      ["PROOF_REQUIRED_FAILURE", "proof_required"],
      ["NETWORK_FAILURE", "network"],
      ["SOMETHING_NEW_FAILURE", "unknown"],
    ] as const
    const results = readSendResults(
      sendResult(...types.map(([type]) => ({ uuid: ALICE, number: NUMBER, type }))),
      "send",
    )
    expect(results.failed.map((failure) => failure.reason)).toEqual(types.map(([, reason]) => reason))
    expect(JSON.stringify(results)).not.toContain(NUMBER)
  })

  test("a result that is not shaped as documented is uncertain", () => {
    for (const result of [
      null,
      "ok",
      {},
      { timestamp: 1 },
      { timestamp: "1", results: [] },
      { timestamp: 1, results: "none" },
      { timestamp: 1, results: [null] },
      { timestamp: 1, results: [{ type: "SUCCESS" }] },
      { timestamp: 1, results: [{ recipientAddress: {}, type: 5 }] },
    ]) {
      expect(() => readSendResults(result, "send")).toThrow(
        expect.objectContaining({ name: "ToolError", code: "uncertain" }) as never,
      )
    }
  })
})

describe("sendOutcome", () => {
  test("returns the results when everyone got it", () => {
    const results = readSendResults(sendResult({ uuid: ALICE, type: "SUCCESS" }), "send")
    expect(sendOutcome(results, "send")).toBe(results)
  })

  test("returns the results, failures listed, when at least one recipient got it", () => {
    const results = readSendResults(
      sendResult({ uuid: ALICE, type: "SUCCESS" }, { uuid: BOB, type: "NETWORK_FAILURE" }),
      "send",
    )
    expect(sendOutcome(results, "send").failed).toEqual([{ recipient: BOB, reason: "network" }])
  })

  test("returns the results when the only recipient got it without an account id", () => {
    const results = readSendResults(sendResult({ number: NUMBER, type: "SUCCESS" }), "send")
    expect(sendOutcome(results, "send")).toBe(results)
  })

  test("all unregistered is not_found", () => {
    const error = outcomeError(
      { uuid: ALICE, type: "UNREGISTERED_FAILURE" },
      { uuid: BOB, type: "UNREGISTERED_FAILURE" },
    )
    expect(error).toMatchObject({ code: "not_found" })
    expect(error.message).toContain("send")
  })

  test("a changed safety number is forbidden, even next to an unregistered recipient", () => {
    expect(outcomeError({ uuid: ALICE, type: "IDENTITY_FAILURE" })).toMatchObject({ code: "forbidden" })
    expect(
      outcomeError({ uuid: ALICE, type: "UNREGISTERED_FAILURE" }, { uuid: BOB, type: "IDENTITY_FAILURE" }),
    ).toMatchObject({ code: "forbidden" })
  })

  test("a rate limit is rate_limited and says how long to wait", () => {
    const error = outcomeError({ uuid: ALICE, type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 120 })
    expect(error).toMatchObject({ code: "rate_limited" })
    expect(error.message).toContain("120 seconds")
    expect(outcomeError({ uuid: ALICE, type: "PROOF_REQUIRED_FAILURE" })).toMatchObject({ code: "rate_limited" })
  })

  test("network and unknown failures are uncertain", () => {
    expect(outcomeError({ uuid: ALICE, type: "NETWORK_FAILURE" })).toMatchObject({ code: "uncertain" })
    expect(outcomeError({ uuid: ALICE, type: "SOMETHING_NEW_FAILURE" })).toMatchObject({ code: "uncertain" })
    expect(
      outcomeError({ uuid: ALICE, type: "UNREGISTERED_FAILURE" }, { uuid: BOB, type: "NETWORK_FAILURE" }),
    ).toMatchObject({ code: "uncertain" })
  })

  test("a result without recipients is uncertain", () => {
    const error = outcomeError()
    expect(error).toMatchObject({ code: "uncertain" })
    expect(error.message).toContain("phone")
  })

  test("a malformed result is uncertain", () => {
    expect(() => sendOutcome(readSendResults({ nonsense: true }, "send"), "send")).toThrow(
      expect.objectContaining({ code: "uncertain" }) as never,
    )
  })
})
