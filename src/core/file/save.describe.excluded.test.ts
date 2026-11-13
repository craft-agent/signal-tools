import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { excludingContext } from "../chat/excluded.testing"
import { callDescription } from "../describe"
import { upsertContacts, upsertGroups } from "../signal/directory"
import { messageId } from "../signal/ids"
import { ALICE, GROUP_ID, NOW, groupDataFrom } from "../signal/mirror.testing"
import { signalFileSave } from "./save"
import { createSaveFixture, SENT, type SaveFixture } from "./save.testing"

const ALICE_NUMBER = "+15555550177"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
  upsertContacts(t.mirror, [{ uuid: ALICE, name: "Alice", number: ALICE_NUMBER }], NOW)
  upsertGroups(t.mirror, [{ id: GROUP_ID, name: "Team", members: [{ uuid: ALICE }], isMember: true }], NOW)
  t.ingest(groupDataFrom(ALICE, SENT, { message: "files", attachments: [{ id: "a", filename: "one.txt" }] }))
})

afterEach(() => {
  t.close()
})

function describeCall(excluded: string[]) {
  return callDescription(
    signalFileSave,
    { chat: `group:${GROUP_ID}`, id: messageId(ALICE, SENT) },
    excludingContext(t.stateDir, excluded),
  )
}

describe("saving files of an excluded person's message in an allowed group", () => {
  test("shows no From fact, and no name or number of theirs", async () => {
    expect((await describeCall([]))?.facts).toContainEqual({ label: "From", value: "Alice" })
    const description = await describeCall([ALICE])
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Files"])
    expect(JSON.stringify(description)).not.toContain("Alice")
    expect(JSON.stringify(description)).not.toContain(ALICE_NUMBER)
  })
})
