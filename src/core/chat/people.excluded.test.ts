import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Mirror } from "../signal/mirror"
import { ALICE, BOB, GROUP_ID, ME, NUMBER, OTHER_GROUP_ID, dataFrom } from "../signal/mirror.testing"
import { People } from "./people"
import { BOB_NUMBER, CAROL, GROUP, OTHER_GROUP, createChatFixture, type ChatFixture } from "./read.testing"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.contacts(
    { uuid: ALICE, name: "Alice" },
    { uuid: BOB, name: "Bob", number: BOB_NUMBER },
    { uuid: ME, number: NUMBER },
  )
})

afterEach(() => {
  t.close()
})

/** A mirror that records the parameters of each statement run on it. */
function spied(mirror: Mirror) {
  const runs: { sql: string; params: unknown[] }[] = []
  const spy = {
    prepare(sql: string) {
      const statement = mirror.prepare(sql)
      const record = (params: unknown[]) => runs.push({ sql, params })
      return {
        all(...params: unknown[]) {
          record(params)
          return statement.all(...(params as never[]))
        },
        get(...params: unknown[]) {
          record(params)
          return statement.get(...(params as never[]))
        },
      }
    },
  }
  return { mirror: spy as unknown as Mirror, runs }
}

describe("People with excluded chats", () => {
  test("never asks the contacts or the messages for an excluded account, and resolves it as an unknown one", () => {
    const spy = spied(t.mirror)
    const people = new People(spy.mirror, ME, new Set([BOB, OTHER_GROUP]))
    people.load([BOB, ALICE, CAROL])
    const [contacts, authors] = spy.runs.filter(({ sql }) => !sql.includes("WHERE uuid = ?"))
    expect(contacts?.params).toEqual([ALICE, CAROL])
    expect(authors?.params).toEqual([CAROL, BOB, OTHER_GROUP])
    expect(authors?.sql).toContain("chat NOT IN")
    expect(people.name(BOB)).toBeNull()
    expect(people.displayName(BOB)).toBeNull()
    expect(people.number(BOB)).toBeNull()
    expect(people.who(BOB)).toBe(BOB)
    expect(people.who(BOB, "Stored")).toBe("Stored")
    expect(people.who(ALICE, "Stored")).toBe("Alice")
    expect(people.who(CAROL, "Stored")).toBe(CAROL)
  })

  test("takes the name an account last wrote under from allowed chats only", () => {
    t.ingest(
      dataFrom(
        CAROL,
        1000,
        { groupInfo: { groupId: GROUP_ID, type: "DELIVER" }, message: "a" },
        { sourceName: "Open" },
      ),
      dataFrom(
        CAROL,
        2000,
        { groupInfo: { groupId: OTHER_GROUP_ID, type: "DELIVER" }, message: "b" },
        { sourceName: "Closed" },
      ),
    )
    t.mirror.prepare("DELETE FROM contacts WHERE uuid = ?").run(CAROL)
    const load = (excluded: string[]) => {
      const people = new People(t.mirror, ME, new Set(excluded))
      people.load([CAROL])
      return people.name(CAROL)
    }
    expect(load([])).toBe("Closed")
    expect(load([OTHER_GROUP])).toBe("Open")
    expect(load([GROUP])).toBe("Closed")
    expect(load([GROUP, OTHER_GROUP])).toBeNull()
  })

  test("keeps the user's own number for masking even when Note to Self is excluded", () => {
    const people = new People(t.mirror, ME, new Set([ME]))
    expect(people.isOwnNumber(NUMBER)).toBe(true)
    expect(people.isOwnNumber(BOB_NUMBER)).toBe(false)
  })
})
