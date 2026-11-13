import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RESULT_BUDGET } from "../pages"
import { ALICE, BOB, NOW, dataFrom } from "../signal/mirror.testing"
import { formatLocalTime } from "../time"
import { withMirror } from "./open"
import { createChatFixture, type ChatFixture } from "./read.testing"
import { searchMessages, SCAN_LIMITS, type ScanLimits } from "./search"

const T = Date.UTC(2026, 10, 7, 5)

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(() => {
  t.close()
})

/** Calls the search method itself, with scan limits of the test's own. */
function search(args: Record<string, unknown>, scan: ScanLimits) {
  return withMirror({ stateDir: t.stateDir }, undefined, (mirror, me) =>
    searchMessages(mirror, me, { query: "needle", ...args }, Date.now(), new Set(), scan),
  )
}

/** `count` messages of Alice, one a millisecond from `T`, with "filler" for text, in one transaction. */
function filler(count: number, from: number) {
  const insert = t.mirror.prepare(
    "INSERT INTO messages (chat, author, ts, from_me, kind, body, expires_in, received) VALUES (?, ?, ?, 0, 'message', 'filler', 0, ?)",
  )
  t.mirror.exec("BEGIN")
  for (let n = 0; n < count; n += 1) insert.run(ALICE, ALICE, from + n, NOW)
  t.mirror.exec("COMMIT")
}

describe("chat read: how far a search looks", () => {
  beforeEach(() => {
    t.ingest(dataFrom(ALICE, T, { message: "the needle" }))
    filler(12, T + 1)
  })

  test("stops after the most messages it may look through, says where, and continues from there", async () => {
    const scan = { chunk: 3, maxScanned: 6 }
    const first = await search({}, scan)
    expect(first.messages).toEqual([])
    expect(first.scanned_to).toBe(formatLocalTime(T + 7))
    expect(first.next).toBeDefined()
    const second = await search({ cursor: first.next }, scan)
    expect(second.messages).toEqual([])
    expect(second.scanned_to).toBe(formatLocalTime(T + 1))
    const third = await search({ cursor: second.next }, scan)
    expect(third.messages?.map((message) => message.text)).toEqual(["the needle"])
    expect(third.scanned_to).toBeUndefined()
    expect(third.next).toBeUndefined()
  })

  test("a limit that is not reached by the bound ends the scan at the hits, with no scanned_to", async () => {
    t.ingest(dataFrom(ALICE, T + 100, { message: "a needle" }), dataFrom(ALICE, T + 101, { message: "another needle" }))
    const page = await search({ limit: 1 }, { chunk: 2, maxScanned: 6 })
    expect(page.messages?.map((message) => message.text)).toEqual(["another needle"])
    expect(page.scanned_to).toBeUndefined()
    const rest = await search({ limit: 5, cursor: page.next }, { chunk: 2, maxScanned: 6 })
    expect(rest.messages?.map((message) => message.text)).toEqual(["a needle"])
    expect(rest.scanned_to).toBe(formatLocalTime(T + 8))
  })

  test("reaching the bound exactly at the end of the history is the end, not a stop", async () => {
    const page = await search({}, { chunk: 5, maxScanned: 13 })
    expect(page.messages?.map((message) => message.text)).toEqual(["the needle"])
    expect(page.next).toBeUndefined()
    expect(page.scanned_to).toBeUndefined()
    const short = await search({}, { chunk: 5, maxScanned: 12 })
    expect(short.messages).toEqual([])
    expect(short.scanned_to).toBe(formatLocalTime(T + 1))
  })

  test("an empty history and a chunk that ends the history exactly are the end", async () => {
    expect((await search({ query: "absent" }, { chunk: 13, maxScanned: 100 })).next).toBeUndefined()
    expect((await search({ query: "absent", chat: BOB }, { chunk: 1, maxScanned: 1 }).catch((e) => e)).code).toBe(
      "not_found",
    )
  })
})

describe("chat read: the real scan limit", () => {
  test("looks through 20,000 messages per call, however the hits lie, and a later call finds the rest", async () => {
    expect(SCAN_LIMITS.maxScanned).toBe(20_000)
    t.ingest(dataFrom(ALICE, T, { message: "the needle" }))
    filler(20_500, T + 1)
    const first = await t.read({ method: "search", query: "needle" })
    expect(first.messages).toEqual([])
    expect(first.scanned_to).toBe(formatLocalTime(T + 501))
    const second = await t.read({ method: "search", query: "needle", cursor: first.next })
    expect(second.messages?.map((message) => message.text)).toEqual(["the needle"])
    expect(second.next).toBeUndefined()
    expect(second.scanned_to).toBeUndefined()
  })

  test("hits found within the limit come back at once, and a full page does not look further", async () => {
    t.ingest(dataFrom(ALICE, T, { message: "old needle" }))
    filler(30_000, T + 1)
    t.ingest(dataFrom(ALICE, T + 40_000, { message: "new needle" }))
    const page = await t.read({ method: "search", query: "needle", limit: 1 })
    expect(page.messages?.map((message) => message.text)).toEqual(["new needle"])
    expect(page.scanned_to).toBeUndefined()
    expect(page.next).toBeDefined()
  })
})

describe("chat read: the size of search results", () => {
  test("hits that are long come back as fewer items and a next that continues", async () => {
    const texts = Array.from({ length: 40 }, (_, n) => `needle ${n} ${"x".repeat(3000)}`)
    texts.forEach((message, n) => t.ingest(dataFrom(ALICE, T + n, { message })))
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await t.read({ method: "search", query: "needle", ...(cursor ? { cursor } : {}) })
      expect(JSON.stringify(page).length).toBeLessThan(RESULT_BUDGET)
      expect(page.messages?.length).toBeLessThan(30)
      seen.push(...(page.messages ?? []).map((message) => message.text ?? ""))
      cursor = page.next
    } while (cursor)
    expect(seen).toEqual([...texts].reverse())
  })

  test("a single hit that alone exceeds the budget is cut and says so", async () => {
    t.ingest(
      dataFrom(ALICE, T, { message: `needle ${"y".repeat(80_000)}` }),
      dataFrom(ALICE, T - 1, { message: "needle" }),
    )
    const page = await t.read({ method: "search", query: "needle" })
    expect(page.messages?.[0]).toMatchObject({ text_cut: true, chat: { id: ALICE } })
    expect(JSON.stringify(page).length).toBeLessThan(RESULT_BUDGET)
    expect(page.next).toBeDefined()
    const rest = await t.read({ method: "search", query: "needle", cursor: page.next })
    expect(rest.messages?.map((message) => message.text)).toEqual(["needle"])
  })
})
