import { afterEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, dataFrom, ME } from "../signal/mirror.testing"
import { ALICE_NUMBER, CAROL, createChatFixture, type ChatFixture } from "./read.testing"
import { People } from "./people"

let fixture: ChatFixture | undefined

afterEach(() => {
  fixture?.close()
  fixture = undefined
})

function loaded(...ids: string[]): People {
  fixture ??= createChatFixture()
  const people = new People(fixture.mirror, ME)
  people.load(ids)
  return people
}

describe("People.name", () => {
  test("is the contact's name", () => {
    fixture = createChatFixture()
    fixture.contacts({ uuid: ALICE, number: ALICE_NUMBER, name: "Alice" })
    expect(loaded(ALICE).name(ALICE)).toBe("Alice")
  })

  test("is null for a contact with only a number, never the number", () => {
    fixture = createChatFixture()
    fixture.contacts({ uuid: BOB, number: ALICE_NUMBER })
    expect(loaded(BOB).name(BOB)).toBeNull()
  })

  test("is the name the account last wrote messages under when no contact has a name", () => {
    fixture = createChatFixture()
    fixture.ingest(dataFrom(CAROL, 1000, { message: "hi" }, { sourceName: "Carol" }))
    fixture.mirror.prepare("DELETE FROM contacts").run()
    expect(loaded(CAROL).name(CAROL)).toBe("Carol")
  })

  test("is the name it wrote under for a contact with a number and no name", () => {
    fixture = createChatFixture()
    fixture.ingest(dataFrom(CAROL, 1000, { message: "hi" }, { sourceName: "Carol" }))
    fixture.mirror.prepare("DELETE FROM contacts").run()
    fixture.contacts({ uuid: CAROL, number: ALICE_NUMBER })
    const people = loaded(CAROL)
    expect(people.name(CAROL)).toBe("Carol")
    expect(people.displayName(CAROL)).toBe(ALICE_NUMBER)
  })

  test("is null for an account that was not loaded", () => {
    fixture = createChatFixture()
    fixture.contacts({ uuid: ALICE, name: "Alice" })
    expect(loaded().name(ALICE)).toBeNull()
  })

  test("is null for the user's own account", () => {
    fixture = createChatFixture()
    fixture.contacts({ uuid: ME, name: "Myself" })
    expect(loaded(ME).name(ME)).toBeNull()
  })
})
