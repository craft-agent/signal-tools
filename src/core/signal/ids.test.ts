import { describe, expect, test } from "bun:test"
import { ALICE, GROUP_ID } from "./mirror.testing"
import { isChatId, messageId, parseMessageId } from "./ids"

describe("message ids", () => {
  test("carry the author and the sent time, and read back", () => {
    const id = messageId(ALICE, 1_800_000_000_123)
    expect(id).toBe(`${ALICE}:1800000000123`)
    expect(parseMessageId(id)).toEqual({ author: ALICE, ts: 1_800_000_000_123 })
  })

  test("accept up to 16 digits that are a safe integer", () => {
    expect(parseMessageId(`${ALICE}:1`)).toEqual({ author: ALICE, ts: 1 })
    expect(parseMessageId(`${ALICE}:9007199254740991`)).toEqual({ author: ALICE, ts: Number.MAX_SAFE_INTEGER })
  })

  test.each([
    "",
    ALICE,
    `${ALICE}:`,
    `${ALICE}:0`,
    `${ALICE}:01`,
    `${ALICE}:-5`,
    `${ALICE}:1.5`,
    `${ALICE}:1e3`,
    `${ALICE}: 5`,
    `${ALICE}:9007199254740992`,
    `${ALICE}:12345678901234567`,
    `${ALICE}:5:6`,
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA:5",
    `${ALICE.slice(1)}:5`,
    `group:${GROUP_ID}:5`,
    "1800000000123",
    ":5",
  ])("refuse %j", (text) => {
    expect(parseMessageId(text)).toBeNull()
  })

  test("a chat id is not a message id and the reverse", () => {
    expect(isChatId(messageId(ALICE, 5))).toBe(false)
    expect(parseMessageId(ALICE)).toBeNull()
  })
})
