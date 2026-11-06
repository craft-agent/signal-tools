import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { openMirrorForRead } from "./mirror"
import { ALICE, GROUP_ID, ME, NOW, NUMBER, columnOf, dataFrom, messageRow, rowsOf } from "./mirror.testing"
import { allGone, eventually, syncFixture, type SyncFixture } from "./sync.testing"

const STRAY_VARIABLE = "SIGNAL_TOOLS_STRAY_SECRET"

let fixture: SyncFixture

afterEach(() => fixture.close())

/** Runs `check` on a read-only view of the label's mirror. */
function inMirror<T>(check: (mirror: ReturnType<typeof openMirrorForRead>) => T): T {
  const mirror = openMirrorForRead(fixture.paths.mirror)
  try {
    return check(mirror)
  } finally {
    mirror.close()
  }
}

describe("runSync receiving", () => {
  test("stores what the daemon emits, refreshes contacts and groups, and stops on request", async () => {
    fixture = syncFixture("daemon-ok")
    fixture.serve({
      payloads: [dataFrom(ALICE, NOW + 1, { message: "hello" }), dataFrom(ALICE, NOW + 2, { message: "again" })],
      contacts: [{ uuid: ALICE, name: "Alice" }],
      groups: [{ id: GROUP_ID, name: "Club", members: [{ uuid: ALICE }, { uuid: ME }] }],
    })

    const { outcome, stop } = fixture.start({ env: { ...fixture.fake.env, [STRAY_VARIABLE]: "secret" } })
    await eventually(() => fixture.meta().refreshed_at !== undefined && fixture.meta().last_received_at !== undefined)

    const running = fixture.meta()
    expect(running).toMatchObject({ status: "running", account_uuid: ME })
    for (const key of ["started_at", "subscribed_at", "last_received_at", "refreshed_at"]) {
      expect(Number(running[key])).toBeGreaterThan(0)
    }
    expect(running.error).toBeUndefined()
    expect(running.groups_stale ?? "0").toBe("0")
    expect(readFileSync(fixture.paths.daemonPid, "utf8").trim()).toBe(String(fixture.pids()[0]))
    expect(statSync(fixture.paths.daemonPid).mode & 0o777).toBe(0o600)
    expect(existsSync(fixture.paths.socket)).toBe(true)

    stop()
    expect(await outcome).toEqual({ exitCode: 0, status: "stopped" })

    expect(fixture.meta()).toMatchObject({ status: "stopped" })
    expect(fixture.meta().error).toBeUndefined()
    inMirror((mirror) => {
      expect(messageRow(mirror, ALICE, NOW + 1)?.body).toBe("hello")
      expect(messageRow(mirror, ALICE, NOW + 2)?.body).toBe("again")
      expect(columnOf(mirror, "SELECT name FROM contacts WHERE uuid = ?", ALICE)).toEqual(["Alice"])
      expect(rowsOf(mirror, "SELECT name FROM chats WHERE kind = 'group'")).toEqual([{ name: "Club" }])
    })
    expect(fixture.fake.rpcCalls()).toEqual([
      { method: "subscribeReceive" },
      { method: "listContacts", params: { allRecipients: true } },
      { method: "listGroups", params: { detailed: true } },
    ])
    expect(fixture.logs).toContain("subscribed")
    expect(fixture.logs.filter((line) => line === "event: message")).toHaveLength(2)
    expect(fixture.logs).toContain("refreshed 1 contacts, 1 groups")
    expect(fixture.logs.at(-1)).toBe("stopped")
  })

  test("starts signal-cli on the label's directory with manual receiving and a minimal environment", async () => {
    fixture = syncFixture("daemon-ok")

    const { outcome, stop } = fixture.start({ env: { ...fixture.fake.env, [STRAY_VARIABLE]: "secret" } })
    await eventually(() => fixture.meta().status === "running")
    stop()
    await outcome

    const [call] = fixture.fake.calls()
    expect(call?.config).toBe(fixture.paths.signalCli)
    expect(call?.args).toEqual([
      "-a",
      NUMBER,
      "daemon",
      "--socket",
      fixture.paths.socket,
      "--receive-mode",
      "manual",
      "--no-receive-stdout",
      "--ignore-stories",
      "--ignore-avatars",
      "--ignore-stickers",
    ])
    expect(call?.env).not.toContain(STRAY_VARIABLE)
  })

  test("leaves nothing behind after a stop request", async () => {
    fixture = syncFixture("daemon-ok")

    const { outcome, stop } = fixture.start()
    await eventually(() => fixture.meta().status === "running")
    stop()
    await outcome

    expect(fixture.pids()).toHaveLength(1)
    expect(allGone(fixture.pids())).toBe(true)
    expect(existsSync(fixture.paths.socket)).toBe(false)
    expect(existsSync(fixture.paths.daemonPid)).toBe(false)
  })

  test("a daemon that ignores SIGTERM is killed after the grace period", async () => {
    fixture = syncFixture("daemon-ignore-term")

    const { outcome, stop } = fixture.start({ stopGraceMs: 300 })
    await eventually(() => fixture.meta().status === "running")
    stop()

    expect(await outcome).toEqual({ exitCode: 0, status: "stopped" })
    expect(allGone(fixture.pids())).toBe(true)
    expect(existsSync(fixture.paths.socket)).toBe(false)
    expect(existsSync(fixture.paths.daemonPid)).toBe(false)
  })

  test("the number never reaches a log, the mirror's status or an outcome", async () => {
    fixture = syncFixture("daemon-ok")
    fixture.serve({ payloads: [{ exception: `could not decode the message from ${NUMBER}` }] })

    const { outcome, stop } = fixture.start()
    await eventually(() => fixture.meta().last_received_at !== undefined)
    stop()
    const result = await outcome

    const logs = fixture.logs.join("\n")
    expect(logs).toContain("signal-cli: INFO Daemon started for [number]")
    expect(logs).toContain("receive error from signal-cli: could not decode the message from [number]")
    expect(logs).toContain("event: no-envelope")
    expect(logs).not.toContain(NUMBER)
    expect(JSON.stringify(fixture.meta())).not.toContain(NUMBER)
    expect(JSON.stringify(result)).not.toContain(NUMBER)
  })
})
