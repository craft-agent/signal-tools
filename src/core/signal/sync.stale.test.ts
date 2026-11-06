import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { NUMBER } from "./mirror.testing"
import { LINKED_ACCOUNT, isRunning, writeSignalCliAccount } from "./signal-cli.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let spawned: ChildProcess[] = []

afterEach(() => {
  for (const child of spawned) child.kill("SIGKILL")
  spawned = []
  fixture.close()
})

/** Starts the fake as a daemon of the fixture's label, the way an earlier run would have, and records it in the pid file. */
async function leaveDaemon(mode: "daemon-ok" | "daemon-ignore-term"): Promise<number> {
  fixture.fake.setMode(mode)
  const child = spawn(
    fixture.fake.program,
    ["--config", fixture.paths.signalCli, "--scrub-log", "-a", NUMBER, "daemon", "--socket", fixture.paths.socket],
    { stdio: "ignore", env: fixture.fake.env },
  )
  spawned.push(child)
  await eventually(() => existsSync(fixture.paths.socket))
  writeFileSync(fixture.paths.daemonPid, `${child.pid}\n`)
  fixture.fake.setMode("daemon-ok")
  return child.pid!
}

/** Starts a process unrelated to the label, whose command line may carry `argument`, and records it in the pid file. */
function leaveProcess(...argument: string[]): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...argument], { stdio: "ignore" })
  spawned.push(child)
  writeFileSync(fixture.paths.daemonPid, `${child.pid}\n`)
  return child.pid!
}

/** Runs the service until it is receiving, then stops it. */
async function runUntilReceiving(): Promise<void> {
  const { outcome, stop } = fixture.start({ stopGraceMs: 300 })
  await eventually(() => fixture.meta().status === "running")
  stop()
  expect((await outcome).status).toBe("stopped")
}

describe("runSync with a daemon left by an earlier run", () => {
  test("stops it before starting its own", async () => {
    fixture = syncFixture("daemon-ok")
    const stale = await leaveDaemon("daemon-ok")

    await runUntilReceiving()

    expect(isRunning(stale)).toBe(false)
    expect(fixture.logs).toContain("stopping a daemon left by an earlier run")
  })

  test("stops it even when the run then ends without starting its own", async () => {
    fixture = syncFixture("daemon-ok")
    writeSignalCliAccount(fixture.paths.signalCli, LINKED_ACCOUNT, false)
    const stale = await leaveDaemon("daemon-ok")

    const outcome = await fixture.run()

    expect(outcome.status).toBe("unlinked")
    expect(isRunning(stale)).toBe(false)
  })

  test("kills one that ignores SIGTERM after the grace period", async () => {
    fixture = syncFixture("daemon-ok")
    const stale = await leaveDaemon("daemon-ignore-term")

    await runUntilReceiving()

    expect(isRunning(stale)).toBe(false)
  })

  test("leaves alone a process that is not this label's daemon", async () => {
    fixture = syncFixture("daemon-ok")
    const unrelated = leaveProcess()

    await runUntilReceiving()

    expect(isRunning(unrelated)).toBe(true)
    expect(fixture.logs).toContain("the pid file names a process that is not this account's daemon; leaving it alone")
  })

  test("leaves alone a process whose command only starts with the label's directory", async () => {
    fixture = syncFixture("daemon-ok")
    const lookalike = leaveProcess(`${fixture.paths.signalCli}.unlinked-20260101000000`)

    await runUntilReceiving()

    expect(isRunning(lookalike)).toBe(true)
  })

  test("ignores a pid file that names no process", async () => {
    fixture = syncFixture("daemon-ok")
    for (const content of ["not a pid\n", "", "0\n", "-5\n", "2147483646\n"]) {
      writeFileSync(fixture.paths.daemonPid, content)

      await runUntilReceiving()
    }
  })

  test("ignores a stale socket file", async () => {
    fixture = syncFixture("daemon-ok")
    writeFileSync(fixture.paths.socket, "")

    await runUntilReceiving()

    expect(existsSync(fixture.paths.socket)).toBe(false)
  })
})
