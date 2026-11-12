import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, ME, NUMBER } from "../signal/mirror.testing"
import { promptMentions } from "./mentions"
import { People } from "./people"
import { BOB_NUMBER, CAROL, createChatFixture, type ChatFixture } from "./read.testing"

const PLACEHOLDER = "\uFFFC"

let t: ChatFixture
let people: People

beforeEach(() => {
  t = createChatFixture()
  t.contacts({ uuid: ALICE, name: "Alice" }, { uuid: BOB, number: BOB_NUMBER }, { uuid: ME, number: NUMBER })
  people = new People(t.mirror, ME)
  people.load([ALICE, BOB, CAROL])
})

afterEach(() => {
  t.close()
})

describe("promptMentions", () => {
  test("names a known account and the user, and marks unknown or number-only accounts with ?", () => {
    const mentions = [
      { start: 0, uuid: ALICE },
      { start: 2, uuid: ME },
      { start: 4, uuid: CAROL },
      { start: 6, uuid: BOB, number: BOB_NUMBER },
      { start: 8, number: BOB_NUMBER },
      { start: 10, number: NUMBER },
      { start: 12 },
    ]
    const text = promptMentions(Array(mentions.length).fill(PLACEHOLDER).join(" "), mentions, people)
    expect(text).toBe("@Alice @me @? @? @? @me @?")
    expect(text).not.toMatch(/5555|44444444|33333333/)
  })

  test("keeps surrounding text and UTF-16 ranges, leaving invalid ranges as they were", () => {
    const text = `😀 ${PLACEHOLDER}, ${PLACEHOLDER}!`
    expect(
      promptMentions(
        text,
        [
          { start: 3, uuid: ALICE },
          { start: 6, uuid: ME },
        ],
        people,
      ),
    ).toBe("😀 @Alice, @me!")
    expect(promptMentions(text, [{ start: 2, uuid: ALICE }], people)).toBe(text)
    expect(promptMentions(text, [], people)).toBe(text)
  })
})
