import { afterEach, describe, expect, test } from "bun:test"
import { ALICE, GROUP_ID, NOW, dataFrom } from "./mirror.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

afterEach(() => fixture.close())

const callsTo = (method: string) => fixture.fake.rpcCalls().filter((call) => call.method === method).length

describe("runSync refreshing", () => {
  test("a group update read while running refreshes the group list again", async () => {
    fixture = syncFixture("daemon-ok")
    fixture.serve({
      groups: [{ id: GROUP_ID, name: "Club", members: [{ uuid: ALICE }] }],
      later: {
        afterMs: 400,
        payloads: [dataFrom(ALICE, NOW + 1, { groupInfo: { groupId: GROUP_ID, type: "UPDATE" } })],
      },
    })

    const { outcome, stop } = fixture.start()
    await eventually(() => callsTo("listGroups") >= 2)
    await eventually(() => fixture.meta().groups_stale === "0")
    stop()
    await outcome

    expect(callsTo("listContacts")).toBe(2)
    expect(fixture.logs.filter((line) => line.startsWith("refreshed"))).toHaveLength(2)
  })

  test("contacts and groups are read again every refresh interval", async () => {
    fixture = syncFixture("daemon-ok")

    const { outcome, stop } = fixture.start({ refreshEveryMs: 150 })
    await eventually(() => callsTo("listContacts") >= 3)
    stop()
    await outcome

    expect(callsTo("listGroups")).toBeGreaterThanOrEqual(3)
  })
})
