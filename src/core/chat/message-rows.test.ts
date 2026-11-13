import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Mirror } from "../signal/mirror"
import { ALICE, BOB, GROUP_ID, OTHER_GROUP_ID, dataFrom, editFrom, reactionFrom } from "../signal/mirror.testing"
import { MESSAGE_COLUMNS, loadRelated, type StoredMessage } from "./message-rows"
import { createChatFixture, type ChatFixture } from "./read.testing"

const T = Date.UTC(2026, 10, 7, 5)

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(() => {
  t.close()
})

function inGroup(source: string, sent: number, message: Record<string, unknown>, groupId = GROUP_ID) {
  return dataFrom(source, sent, { groupInfo: { groupId, type: "DELIVER" }, ...message })
}

/** The stored messages of `chat`, oldest first. */
function rowsOf(chat: string): StoredMessage[] {
  return t.mirror
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat = ? ORDER BY ts`)
    .all(chat) as StoredMessage[]
}

/** A mirror that records the statements prepared on it and every row they return. */
function spied(mirror: Mirror) {
  const statements: { sql: string; params: unknown[] }[] = []
  const returned: unknown[] = []
  const spy = {
    prepare(sql: string) {
      const statement = mirror.prepare(sql)
      return {
        all(...params: unknown[]) {
          statements.push({ sql, params })
          const rows = statement.all(...(params as never[]))
          returned.push(...rows)
          return rows
        },
      }
    },
  }
  return { mirror: spy as unknown as Mirror, statements, returned }
}

describe("loadRelated", () => {
  test("reads the related rows of the messages given, by their exact author and time", () => {
    t.ingest(
      inGroup(ALICE, T, { message: "open one" }),
      inGroup(ALICE, T + 2, { message: "open two" }),
      inGroup(ALICE, T + 1, { message: "closed old" }, OTHER_GROUP_ID),
      inGroup(BOB, T + 1, { message: "closed bob" }, OTHER_GROUP_ID),
      editFrom(ALICE, T + 1, T + 11, { message: "closed new" }),
      reactionFrom(BOB, T + 1, ALICE, "🤫"),
      editFrom(ALICE, T + 2, T + 12, { message: "open two edited" }),
      reactionFrom(BOB, T, ALICE, "👍"),
    )
    const spy = spied(t.mirror)
    const related = loadRelated(spy.mirror, rowsOf(`group:${GROUP_ID}`))

    expect([...related.reactions.keys()]).toEqual([`${ALICE}:${T}`])
    expect(related.reactions.get(`${ALICE}:${T}`)).toEqual([{ reactor: BOB, emoji: "👍" }])
    expect([...related.versions.keys()]).toEqual([`${ALICE}:${T + 2}`])
    expect(related.versions.get(`${ALICE}:${T + 2}`)).toEqual([{ rev_ts: T + 2, body: "open two", mentions: null }])

    expect(spy.statements).toHaveLength(2)
    for (const { params } of spy.statements) expect(params).toEqual([ALICE, T, ALICE, T + 2])
    expect(JSON.stringify(spy.returned)).not.toContain("closed")
    expect(JSON.stringify(spy.returned)).not.toContain("🤫")
  })

  test("keeps each message's reactions and versions in their order, across queries", () => {
    const count = 450
    t.mirror.exec("BEGIN")
    const insert = t.mirror.prepare(
      "INSERT INTO messages (chat, author, ts, from_me, kind, body, expires_in, received) VALUES (?, ?, ?, 0, 'message', 'm', 0, 0)",
    )
    const react = t.mirror.prepare("INSERT INTO reactions (author, ts, reactor, emoji, at) VALUES (?, ?, ?, ?, ?)")
    const edit = t.mirror.prepare("INSERT INTO edits (author, ts, rev_ts, body) VALUES (?, ?, ?, ?)")
    for (let n = 0; n < count; n += 1) {
      insert.run(`group:${GROUP_ID}`, ALICE, T + n)
      react.run(ALICE, T + n, BOB, "🎉", 2)
      react.run(ALICE, T + n, ALICE, "👍", 1)
      edit.run(ALICE, T + n, T + n + 20, `v${n} late`)
      edit.run(ALICE, T + n, T + n + 10, `v${n} early`)
    }
    t.mirror.exec("COMMIT")
    const related = loadRelated(t.mirror, rowsOf(`group:${GROUP_ID}`))
    expect(related.reactions.size).toBe(count)
    expect(related.versions.size).toBe(count)
    for (const n of [0, 199, 200, 449]) {
      const id = `${ALICE}:${T + n}`
      expect(related.reactions.get(id)).toEqual([
        { reactor: ALICE, emoji: "👍" },
        { reactor: BOB, emoji: "🎉" },
      ])
      expect(related.versions.get(id)?.map((version) => version.body)).toEqual([`v${n} early`, `v${n} late`])
    }
  })

  test("reads nothing for no message, and nothing for timers", () => {
    t.ingest(inGroup(ALICE, T, { isExpirationUpdate: true, expiresInSeconds: 60 }))
    const spy = spied(t.mirror)
    const rows = rowsOf(`group:${GROUP_ID}`)
    expect(rows.map((row) => row.kind)).toEqual(["timer"])
    expect(loadRelated(spy.mirror, rows).reactions.size).toBe(0)
    expect(loadRelated(spy.mirror, []).versions.size).toBe(0)
    expect(spy.statements).toEqual([])
  })
})
