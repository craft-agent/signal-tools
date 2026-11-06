import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { labelPaths } from "./labels"
import { ACCOUNT_UUID_META } from "./mirror-meta"
import { openMirrorForWrite, setMeta } from "./mirror"
import { ALICE } from "./mirror.testing"
import { LINKED_ACCOUNT, writeSignalCliAccount } from "./signal-cli.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

const HELD_REASON = "another sync service is already running for this account"
/** A process id no process has. */
const DEAD_PID = 2_147_483_646

let fixture: SyncFixture
let holders: ChildProcess[] = []

afterEach(() => {
  for (const holder of holders) holder.kill("SIGKILL")
  holders = []
  fixture.close()
})

/** Starts a process that stays alive, for the lock to name. */
function liveHolder(): number {
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  holders.push(holder)
  return holder.pid!
}

const readLock = () => readFileSync(fixture.paths.syncLock, "utf8")

describe("runSync lock", () => {
  test("a label whose lock names a live process is left alone, with exit 1", async () => {
    fixture = syncFixture("daemon-ok")
    const holder = liveHolder()
    writeFileSync(fixture.paths.syncLock, `${holder}\n`)
    writeFileSync(fixture.paths.daemonPid, "4242\n")

    const outcome = await fixture.run()

    expect(outcome).toEqual({ exitCode: 1, status: "failed", reason: HELD_REASON })
    expect(fixture.logs).toEqual([HELD_REASON])
    expect(readLock()).toBe(`${holder}\n`)
    expect(readFileSync(fixture.paths.daemonPid, "utf8")).toBe("4242\n")
    expect(existsSync(fixture.paths.mirror)).toBe(false)
    expect(fixture.fake.calls()).toEqual([])
  })

  test("a lock whose process is gone, or that holds no pid, is taken over", async () => {
    fixture = syncFixture("daemon-ok")
    for (const content of [`${DEAD_PID}\n`, "garbage", ""]) {
      writeFileSync(fixture.paths.syncLock, content)

      const { outcome, stop } = fixture.start()
      await eventually(() => fixture.meta().status === "running")
      expect(readLock()).toBe(`${process.pid}\n`)
      stop()
      expect((await outcome).status).toBe("stopped")
    }
  })

  test("the lock is private to its owner and released when the run ends", async () => {
    fixture = syncFixture("daemon-ok")

    const { outcome, stop } = fixture.start()
    await eventually(() => fixture.meta().status === "running")
    expect(statSync(fixture.paths.syncLock).mode & 0o777).toBe(0o600)
    stop()
    await outcome

    expect(existsSync(fixture.paths.syncLock)).toBe(false)
  })

  test("the lock is released on every early end", async () => {
    fixture = syncFixture("daemon-ok")
    const empty = labelPaths(fixture.stateDir, "empty")
    mkdirSync(empty.dir)
    expect((await fixture.run({ label: "empty" })).status).toBe("not linked")
    expect(existsSync(empty.syncLock)).toBe(false)

    const mirror = openMirrorForWrite(fixture.paths.mirror)
    setMeta(mirror, { [ACCOUNT_UUID_META]: ALICE })
    mirror.close()
    expect((await fixture.run()).status).toBe("failed")
    expect(existsSync(fixture.paths.syncLock)).toBe(false)

    expect((await fixture.run({ minFreeBytes: Number.MAX_SAFE_INTEGER })).status).toBe("failed")
    expect(existsSync(fixture.paths.syncLock)).toBe(false)

    writeSignalCliAccount(fixture.paths.signalCli, LINKED_ACCOUNT, false)
    expect((await fixture.run()).status).toBe("unlinked")
    expect(existsSync(fixture.paths.syncLock)).toBe(false)
  })

  test("the lock is released after a failed run", async () => {
    fixture = syncFixture("daemon-unlinked")
    writeSignalCliAccount(fixture.paths.signalCli, LINKED_ACCOUNT)

    await fixture.run()

    expect(existsSync(fixture.paths.syncLock)).toBe(false)
  })
})
