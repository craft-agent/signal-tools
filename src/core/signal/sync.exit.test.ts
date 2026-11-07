import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { openMirrorForRead } from "./mirror"
import { ALICE, NOW, NUMBER, columnOf, dataFrom } from "./mirror.testing"
import { LINKED_ACCOUNT, hasExited, writeSignalCliAccount } from "./signal-cli.testing"
import { allGone, eventually, syncFixture, type SyncFixture } from "./sync.testing"

/** The longest a test keeps the service busy while it waits for the daemon to exit. */
const BUSY_LIMIT_MS = 5_000

let fixture: SyncFixture

afterEach(() => fixture.close())

describe("runSync when the daemon goes away", () => {
  test("a daemon that exits stores what it emitted first, then fails", async () => {
    fixture = syncFixture("daemon-exit-after-envelopes")
    const texts = ["one", "two", "three"]
    fixture.serve({ payloads: texts.map((message, index) => dataFrom(ALICE, NOW + index + 1, { message })) })

    const outcome = await fixture.run()

    expect(outcome).toEqual({ exitCode: 1, status: "failed", reason: "signal-cli exited (code 3)" })
    const mirror = openMirrorForRead(fixture.paths.mirror)
    expect(columnOf(mirror, "SELECT body FROM messages ORDER BY ts")).toEqual(texts)
    mirror.close()
    expect(fixture.meta()).toMatchObject({ status: "failed", error: "signal-cli exited (code 3)" })
    expect(allGone(fixture.pids())).toBe(true)
    expect(existsSync(fixture.paths.socket)).toBe(false)
    expect(existsSync(fixture.paths.daemonPid)).toBe(false)
    expect(fixture.logs.at(-1)).toBe("sync ended: signal-cli exited (code 3)")
  })

  test("a daemon that exits while the service is busy still has its envelopes stored", async () => {
    fixture = syncFixture("daemon-exit-after-pause")
    const texts = ["one", "two", "three"]
    fixture.serve({ payloads: texts.map((message, index) => dataFrom(ALICE, NOW + index + 1, { message })) })
    // Busy between the subscription and the first refresh, until the daemon is gone with its envelopes unread.
    const log = (line: string) => {
      fixture.logs.push(line)
      if (line !== "subscribed") return
      const deadline = Date.now() + BUSY_LIMIT_MS
      while (!hasExited(fixture.pids()[0]!) && Date.now() < deadline);
    }

    const outcome = await fixture.run({ log })

    expect(outcome).toEqual({ exitCode: 1, status: "failed", reason: "signal-cli exited (code 3)" })
    const mirror = openMirrorForRead(fixture.paths.mirror)
    expect(columnOf(mirror, "SELECT body FROM messages ORDER BY ts")).toEqual(texts)
    mirror.close()
  })

  test("a daemon that is killed fails with the signal that ended it", async () => {
    fixture = syncFixture("daemon-ok")

    const { outcome } = fixture.start()
    await eventually(() => fixture.meta().status === "running")
    process.kill(fixture.pids()[0]!, "SIGKILL")

    expect(await outcome).toEqual({ exitCode: 1, status: "failed", reason: "signal-cli exited (signal SIGKILL)" })
    expect(existsSync(fixture.paths.socket)).toBe(false)
  })

  test("signal-cli saying Signal does not know the device ends as unlinked, exit 0", async () => {
    fixture = syncFixture("daemon-unlinked")

    const outcome = await fixture.run()

    expect(outcome.exitCode).toBe(0)
    expect(outcome.status).toBe("unlinked")
    expect(fixture.meta()).toMatchObject({ status: "unlinked" })
    expect(fixture.meta().error).toBeString()
    const logs = fixture.logs.join("\n")
    expect(logs).toContain("signal-cli: ERROR Not registered: [number]")
    expect(logs).toContain("staying down until it is linked again")
    expect(logs).not.toContain(NUMBER)
    expect(allGone(fixture.pids())).toBe(true)
  })

  test("an account file that now says unlinked ends as unlinked too", async () => {
    fixture = syncFixture("daemon-ok")

    const { outcome } = fixture.start()
    await eventually(() => fixture.meta().status === "running")
    writeSignalCliAccount(fixture.paths.signalCli, LINKED_ACCOUNT, false)
    process.kill(fixture.pids()[0]!, "SIGKILL")

    expect((await outcome).status).toBe("unlinked")
    expect(fixture.meta().status).toBe("unlinked")
  })

  test("a daemon whose socket never opens fails after the wait and is stopped", async () => {
    fixture = syncFixture("daemon-no-socket")

    const outcome = await fixture.run({ socketWaitMs: 700 })

    expect(outcome).toEqual({ exitCode: 1, status: "failed", reason: "the daemon's socket never opened" })
    expect(fixture.meta()).toMatchObject({ status: "failed", error: "the daemon's socket never opened" })
    expect(allGone(fixture.pids())).toBe(true)
    expect(existsSync(fixture.paths.daemonPid)).toBe(false)
  })

  test("a stop request while the socket is awaited stops the daemon", async () => {
    fixture = syncFixture("daemon-no-socket")

    const { outcome, stop } = fixture.start()
    await eventually(() => fixture.pids().length > 0)
    stop()

    expect(await outcome).toEqual({ exitCode: 0, status: "stopped" })
    expect(allGone(fixture.pids())).toBe(true)
    expect(existsSync(fixture.paths.daemonPid)).toBe(false)
  })

  test("a signal-cli that cannot be started fails without leaving a pid file", async () => {
    fixture = syncFixture("daemon-ok")

    const outcome = await fixture.run({ program: join(fixture.stateDir, "missing") })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.status).toBe("failed")
    expect(outcome.reason).toContain("not installed")
    expect(existsSync(fixture.paths.daemonPid)).toBe(false)
  })
})
