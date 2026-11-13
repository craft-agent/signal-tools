import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { excludingContext } from "../../chat/excluded.testing"
import { ALICE_NUMBER, GROUP } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { messageId } from "../../signal/ids"
import { ALICE } from "../../signal/mirror.testing"
import { FILE_WORDS } from "../words"
import { signalFileSend } from "./tool"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
})

afterEach(async () => {
  await t.close()
})

function describeCall(excluded: string[]) {
  t.write("a.txt", "x")
  const ctx = { ...excludingContext(t.stateDir, excluded), cwd: t.work }
  return callDescription(
    signalFileSend,
    { chat: GROUP, files: [{ path: "a.txt" }], reply_to: messageId(ALICE, 2000) },
    ctx,
  )
}

describe("a file reply in an allowed group to an excluded person", () => {
  test("names no author, and shows no name or number of theirs", async () => {
    expect((await describeCall([]))?.headline?.values).toMatchObject({ author: "Alice", chat: "Team" })
    const description = await describeCall([ALICE])
    expect(description?.headline).toEqual({
      text: FILE_WORDS.replyOneHeadlineUnnamed,
      values: { file: "a.txt", chat: "Team" },
    })
    expect(JSON.stringify(description)).not.toContain("Alice")
    expect(JSON.stringify(description)).not.toContain(ALICE_NUMBER)
  })
})
