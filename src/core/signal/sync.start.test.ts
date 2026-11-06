import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { ACCOUNT_UUID_META } from "./account"
import { labelPaths } from "./labels"
import { openMirrorForWrite, setMeta } from "./mirror"
import { ALICE, ME } from "./mirror.testing"
import { LINKED_ACCOUNT, writeSignalCliAccount } from "./signal-cli.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

afterEach(() => fixture.close())

/** Writes values into the label's mirror before the service runs. */
function seedMirror(values: Record<string, string>): void {
  const mirror = openMirrorForWrite(fixture.paths.mirror)
  setMeta(mirror, values)
  mirror.close()
}

describe("runSync before anything starts", () => {
  test("a label without a directory is not linked and nothing is created", async () => {
    fixture = syncFixture("daemon-ok")

    const outcome = await fixture.run({ label: "elsewhere" })

    expect(outcome).toEqual({ exitCode: 0, status: "not linked" })
    expect(existsSync(join(fixture.stateDir, "elsewhere"))).toBe(false)
    expect(fixture.fake.calls()).toEqual([])
  })

  test("a label directory without an account is not linked and gets no mirror", async () => {
    fixture = syncFixture("daemon-ok")
    const empty = labelPaths(fixture.stateDir, "empty")
    mkdirSync(empty.dir)

    const outcome = await fixture.run({ label: "empty" })

    expect(outcome).toEqual({ exitCode: 0, status: "not linked" })
    expect(existsSync(empty.mirror)).toBe(false)
    expect(fixture.fake.calls()).toEqual([])
  })

  test("an unlinked device with a mirror records it and does not start signal-cli", async () => {
    fixture = syncFixture("daemon-ok")
    writeSignalCliAccount(fixture.paths.signalCli, LINKED_ACCOUNT, false)
    seedMirror({})

    const outcome = await fixture.run()

    expect(outcome.exitCode).toBe(0)
    expect(outcome.status).toBe("unlinked")
    expect(fixture.meta().status).toBe("unlinked")
    expect(fixture.meta().error).toBeString()
    expect(fixture.fake.calls()).toEqual([])
  })

  test("an unlinked device without a mirror leaves none", async () => {
    fixture = syncFixture("daemon-ok")
    writeSignalCliAccount(fixture.paths.signalCli, LINKED_ACCOUNT, false)

    const outcome = await fixture.run()

    expect(outcome.status).toBe("unlinked")
    expect(existsSync(fixture.paths.mirror)).toBe(false)
  })

  test("a mirror that holds another account's history is refused", async () => {
    fixture = syncFixture("daemon-ok")
    seedMirror({ [ACCOUNT_UUID_META]: ALICE })

    const outcome = await fixture.run()

    expect(outcome).toEqual({
      exitCode: 1,
      status: "failed",
      reason: "this label's history belongs to another account",
    })
    expect(fixture.meta()).toMatchObject({ status: "failed", [ACCOUNT_UUID_META]: ALICE })
    expect(fixture.fake.calls()).toEqual([])
  })

  test("a mirror that holds this account's history is taken over", async () => {
    fixture = syncFixture("daemon-exit-after-envelopes")
    seedMirror({ [ACCOUNT_UUID_META]: ME, error: "left over", subscribed_at: "1" })

    const outcome = await fixture.run()

    expect(outcome.status).toBe("failed")
    expect(fixture.meta()[ACCOUNT_UUID_META]).toBe(ME)
    expect(fixture.meta().started_at).toBeString()
  })

  test("too little free space fails after the wait, with the mirror saying so", async () => {
    fixture = syncFixture("daemon-ok")
    const started = Date.now()

    const outcome = await fixture.run({ minFreeBytes: Number.MAX_SAFE_INTEGER, diskWaitMs: 100 })

    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    expect(outcome.exitCode).toBe(1)
    expect(outcome.status).toBe("failed")
    expect(outcome.reason).toContain("disk")
    expect(fixture.meta().status).toBe("failed")
    expect(fixture.fake.calls()).toEqual([])
  })

  test("a stop request cuts the wait for room short", async () => {
    fixture = syncFixture("daemon-ok")

    const { outcome, stop } = fixture.start({ minFreeBytes: Number.MAX_SAFE_INTEGER, diskWaitMs: 60_000 })
    stop()

    expect((await outcome).status).toBe("failed")
  })

  test("a stop request before the daemon starts stops without starting it", async () => {
    fixture = syncFixture("daemon-ok")

    const { outcome, stop } = fixture.start()
    stop()

    expect(await outcome).toEqual({ exitCode: 0, status: "stopped" })
    expect(fixture.meta().status).toBe("stopped")
    expect(fixture.fake.calls()).toEqual([])
  })
})
