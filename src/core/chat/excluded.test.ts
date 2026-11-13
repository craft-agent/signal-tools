import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { excludedChats, excludedCondition, refuseExcludedChats } from "./excluded"

const PERSON = "1a2b3c4d-2222-4333-8444-5555555555ab"
const GROUP = `group:${"G".repeat(43)}`

describe("excluded chats", () => {
  test("defaults to none and keeps each distinct chat id once", () => {
    expect([...excludedChats({})]).toEqual([])
    expect([...excludedChats({ options: { exclude_chats: [PERSON, GROUP, PERSON] } })]).toEqual([PERSON, GROUP])
  })

  test.each(["", "private", "+15550100", "group:", "group:short", PERSON.toUpperCase(), ` ${PERSON}`])(
    "refuses setting entry %j without showing it",
    (chat) => {
      expect(() => excludedChats({ options: { exclude_chats: [chat] } })).toThrow(
        new ToolError(
          "invalid_argument",
          "The exclude_chats setting holds an entry that is not a chat id; set it to chat ids as list gives them.",
        ),
      )
    },
  )

  test("refuses a setting that is not a list of strings", () => {
    expect(() => excludedChats({ options: { exclude_chats: PERSON } })).toThrow(ToolError)
    expect(() => excludedChats({ options: { exclude_chats: true } })).toThrow(ToolError)
  })

  test("throws the supplied refusal for the first excluded chat", () => {
    const refusal = new ToolError("not_found", "unknown")
    const ctx = { options: { exclude_chats: [GROUP, PERSON] } }
    expect(() => refuseExcludedChats(ctx, ["other"], () => refusal)).not.toThrow()
    expect(() =>
      refuseExcludedChats(ctx, [PERSON, GROUP], (chat) => {
        expect(chat).toBe(PERSON)
        return refusal
      }),
    ).toThrow(refusal)
  })

  test("checks the setting even when no chat is named", () => {
    expect(() =>
      refuseExcludedChats({ options: { exclude_chats: ["x"] } }, [], () => new ToolError("not_found", "")),
    ).toThrow(expect.objectContaining({ code: "invalid_argument" }))
  })

  test("builds a parameterized SQL condition only when needed", () => {
    expect(excludedCondition("m.chat", new Set())).toBeUndefined()
    expect(excludedCondition("m.chat", new Set([PERSON, GROUP]))).toEqual({
      sql: "m.chat NOT IN (?, ?)",
      params: [PERSON, GROUP],
    })
  })
})
