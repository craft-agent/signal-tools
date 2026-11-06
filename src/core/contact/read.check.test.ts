import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs"
import { failureOf, startFakeDaemon, type FakeDaemon, type FakeReply } from "../signal/daemon.testing"
import { labelPaths } from "../signal/labels"
import { openMirrorForWrite, setMeta } from "../signal/mirror"
import { ACCOUNT_UUID_META } from "../signal/mirror-meta"
import { ALICE, BOB, ME, NUMBER, makeTempDir } from "../signal/mirror.testing"
import { invoke } from "../tool"
import { signalContactRead } from "./read"

const OTHER_NUMBER = "+15555550124"
const THIRD_NUMBER = "+15555550125"
let stateDir: string
let daemon: FakeDaemon | undefined

beforeEach(() => {
  stateDir = makeTempDir()
  mkdirSync(labelPaths(stateDir, "default").dir)
})

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  rmSync(stateDir, { recursive: true, force: true })
})

async function serve(reply: FakeReply) {
  daemon = await startFakeDaemon(() => reply)
  symlinkSync(daemon.socketPath, labelPaths(stateDir, "default").socket)
  return daemon
}

function check(numbers: unknown = [NUMBER], args = {}) {
  return invoke(signalContactRead, { method: "check", numbers, ...args }, { cwd: stateDir, stateDir })
}

test("matches number or recipient and returns requested order, not daemon order", async () => {
  const fake = await serve({
    result: [
      { recipient: OTHER_NUMBER, isRegistered: false },
      { recipient: "ignored", number: NUMBER, uuid: ALICE.toUpperCase(), isRegistered: true },
    ],
  })
  expect(await check([NUMBER, OTHER_NUMBER, THIRD_NUMBER])).toEqual({
    numbers: [
      { number: NUMBER, on_signal: true, chat: ALICE },
      { number: OTHER_NUMBER, on_signal: false },
      { number: THIRD_NUMBER, on_signal: false },
    ],
    note: "Not found also means the person hid their number from search, or Signal limited lookups for now. A found number's chat id can be used at once; it appears among the contacts after the sync service next refreshes them.",
  })
  expect(fake.calls).toEqual([{ method: "getUserStatus", params: { recipient: [NUMBER, OTHER_NUMBER, THIRD_NUMBER] } }])
  expect(existsSync(labelPaths(stateDir, "default").mirror)).toBe(false)
})

test("normalizes separators and collapses duplicates in input order", async () => {
  const fake = await serve({ result: [{ number: NUMBER, uuid: BOB, isRegistered: true }] })
  expect((await check(["+1 (555) 555-01.23", NUMBER, OTHER_NUMBER])).numbers).toEqual([
    { number: NUMBER, on_signal: true, chat: BOB },
    { number: OTHER_NUMBER, on_signal: false },
  ])
  expect(fake.calls[0]?.params).toEqual({ recipient: [NUMBER, OTHER_NUMBER] })
})

test("matches formatted number and recipient fields in shuffled results", async () => {
  await serve({
    result: [
      { number: "+1 (555) 555.0124", uuid: BOB, isRegistered: true },
      { recipient: "+1 555-555-0123", uuid: ALICE, isRegistered: true },
    ],
  })
  expect((await check([NUMBER, OTHER_NUMBER])).numbers).toEqual([
    { number: NUMBER, on_signal: true, chat: ALICE },
    { number: OTHER_NUMBER, on_signal: true, chat: BOB },
  ])
})

test.each([
  { uuid: "not a uuid", isRegistered: true },
  { isRegistered: true },
  { uuid: ALICE, isRegistered: false },
  { uuid: ALICE },
])("requires registration and a valid uuid: %j", async (entry) => {
  await serve({ result: [{ number: NUMBER, ...entry }] })
  expect((await check()).numbers).toEqual([{ number: NUMBER, on_signal: false }])
})

test.each(
  [null, [], [null], [{ number: OTHER_NUMBER, uuid: ALICE, isRegistered: true }]].map((result) => ({ result })),
)("handles absent entries: %j", async ({ result }) => {
  await serve({ result })
  expect((await check()).numbers).toEqual([{ number: NUMBER, on_signal: false }])
})

test.each(["15555550123", "+05555550123", "+123456", "+1234567890123456", "+1x5555550123", "+1\t5555550123", ""])(
  "refuses bad number %j and names its position",
  async (bad) => {
    const error = await failureOf(check([NUMBER, bad]))
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(error.message).toContain("entry 2")
  },
)

test.each([undefined, [], "number", [1]].map((numbers) => ({ numbers })))(
  "requires an array of one to three strings: %j",
  async ({ numbers }) => {
    const args = numbers === undefined ? {} : { numbers }
    await expect(
      invoke(signalContactRead, { method: "check", ...args }, { cwd: stateDir, stateDir }),
    ).rejects.toMatchObject({ code: "invalid_argument" })
  },
)

test("refuses more than three before collapsing duplicates or reaching the daemon", async () => {
  const fake = await serve({ result: [] })
  const error = await failureOf(check([NUMBER, NUMBER, NUMBER, NUMBER]))
  expect(error).toMatchObject({ code: "invalid_argument" })
  expect(error.message).toContain("lookup of every number it knows")
  expect(error.message).toContain("lookup allowance")
  expect(fake.calls).toEqual([])
})

test("not running asks to start the sync service", async () => {
  await expect(check()).rejects.toMatchObject({
    code: "upstream_error",
    message: "The Signal daemon is not running for this account; start its sync service.",
  })
})

test("maps -5 to rate_limited", async () => {
  await serve({ error: { code: -5, message: "try later" } })
  await expect(check()).rejects.toMatchObject({ code: "rate_limited" })
})

test("does not rewrite other upstream errors as not running", async () => {
  await serve("close")
  const error = await failureOf(check())
  expect(error).toMatchObject({ code: "upstream_error" })
  expect(error.message).not.toContain("start its sync service")
})

test("allows the given own number and never adds any number from local state or writes the mirror", async () => {
  const paths = labelPaths(stateDir, "default")
  const mirror = openMirrorForWrite(paths.mirror)
  setMeta(mirror, { [ACCOUNT_UUID_META]: ME })
  mirror.close()
  const before = statSync(paths.mirror)
  const bytes = readFileSync(paths.mirror)
  const fake = await serve({ result: [{ number: NUMBER, uuid: ME, isRegistered: true }] })
  expect((await check()).numbers).toEqual([{ number: NUMBER, on_signal: true, chat: ME }])
  expect(fake.calls[0]?.params).toEqual({ recipient: [NUMBER] })
  expect(readFileSync(paths.mirror)).toEqual(bytes)
  expect(statSync(paths.mirror).mtimeMs).toBe(before.mtimeMs)
  expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
})

test.each([{ query: "Alice" }, { limit: 1 }, { cursor: "bad" }, { unknown: true }])(
  "refuses list-only and unknown arguments: %j",
  async (args) => {
    await expect(check([NUMBER], args)).rejects.toMatchObject({ code: "invalid_argument" })
  },
)
