import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNCERTAIN_MESSAGES } from "../../message/constants"
import { SENT } from "../../message/send.testing"
import { rowsOf } from "../../signal/mirror.testing"
import { createFileSend, signalFileSend } from "./tool"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"
import { ALICE } from "../../signal/mirror.testing"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
})

afterEach(async () => {
  await t.close()
})

/** Waits until the fake daemon has received the send, i.e. the files were written to it. */
async function untilWritten(): Promise<void> {
  while (t.sends() === 0) await new Promise((resolve) => setTimeout(resolve, 5))
}

/** What a send that ended `uncertain` leaves: the message's words, no copies, and no record. */
function expectUncertain(error: Error): void {
  expect(error).toMatchObject({ code: "uncertain", message: UNCERTAIN_MESSAGES.send })
  expect(t.outboxEntries()).toEqual([])
  expect(rowsOf(t.mirror, "SELECT 1 FROM messages WHERE ts >= ?", SENT)).toEqual([])
}

describe("a send whose answer never comes", () => {
  test("is uncertain when the time limit is hit after the files were written", async () => {
    await t.serve("hang")
    const patient = createFileSend({ uploadTimeoutMs: 100 })
    const started = Date.now()
    const error = await t.filesFailure({ chat: ALICE, files: [{ path: t.write("a.txt") }] }, {}, patient)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(t.sends()).toBe(1)
    expectUncertain(error)
  })

  test("is uncertain when the call is cancelled after the files were written", async () => {
    await t.serve("hang")
    const controller = new AbortController()
    const pending = t.filesFailure(
      { chat: ALICE, files: [{ path: t.write("a.txt") }] },
      { signal: controller.signal },
      signalFileSend,
    )
    await untilWritten()
    controller.abort()
    expectUncertain(await pending)
  })

  test("the copies are still there while the daemon holds the request, and gone once the call ends", async () => {
    const seen = await t.serveAndSee("hang")
    const controller = new AbortController()
    const pending = t.filesFailure({ chat: ALICE, files: [{ path: t.write("a.txt") }] }, { signal: controller.signal })
    await untilWritten()
    expect(t.outboxEntries()).toHaveLength(1)
    controller.abort()
    expectUncertain(await pending)
    expect(seen).toHaveLength(1)
  })
})
