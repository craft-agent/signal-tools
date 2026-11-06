import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { openMirrorForWrite } from "./mirror"
import { ALICE, NOW, dataFrom } from "./mirror.testing"
import { allGone, eventually, syncFixture, type SyncFixture } from "./sync.testing"

const STORAGE_REASON = "the mirror cannot be written; receiving stopped"

let fixture: SyncFixture

afterEach(() => fixture.close())

describe("runSync when the mirror cannot be written", () => {
  test("stops the daemon at once instead of draining, and fails", async () => {
    fixture = syncFixture("daemon-ok")
    fixture.serve({
      later: {
        afterMs: 1_000,
        payloads: [dataFrom(ALICE, NOW + 1, { message: "one" }), dataFrom(ALICE, NOW + 2, { message: "two" })],
      },
    })

    const { outcome } = fixture.start({ drainMs: 5_000 })
    await eventually(() => fixture.meta().status === "running")
    // Another writer takes the messages table away: the next envelope cannot be stored.
    const other = openMirrorForWrite(fixture.paths.mirror)
    other.exec("DROP TABLE messages")
    other.close()
    const broken = Date.now()

    expect(await outcome).toEqual({ exitCode: 1, status: "failed", reason: STORAGE_REASON })

    expect(Date.now() - broken).toBeLessThan(4_000)
    expect(allGone(fixture.pids())).toBe(true)
    expect(existsSync(fixture.paths.socket)).toBe(false)
    expect(existsSync(fixture.paths.daemonPid)).toBe(false)
    expect(fixture.meta()).toMatchObject({ status: "failed", error: STORAGE_REASON })
    expect(fixture.logs.filter((line) => line === STORAGE_REASON)).toHaveLength(1)
    expect(fixture.logs.filter((line) => line.startsWith("event:"))).toEqual([])
  })

  test("a store that fails while draining after a stop request still fails the run", async () => {
    fixture = syncFixture("daemon-ignore-term")
    fixture.serve({ later: { afterMs: 800, payloads: [dataFrom(ALICE, NOW + 1, { message: "late" })] } })

    const { outcome, stop } = fixture.start({ stopGraceMs: 2_000 })
    await eventually(() => fixture.meta().status === "running")
    const other = openMirrorForWrite(fixture.paths.mirror)
    other.exec("DROP TABLE messages")
    other.close()
    // The daemon ignores SIGTERM, so the envelope it emits next arrives while the service is stopping it.
    stop()

    expect(await outcome).toEqual({ exitCode: 1, status: "failed", reason: STORAGE_REASON })
    expect(fixture.meta()).toMatchObject({ status: "failed", error: STORAGE_REASON })
    expect(allGone(fixture.pids())).toBe(true)
  })

  test("a mirror that fails right after the subscription is a storage failure as well", async () => {
    fixture = syncFixture("daemon-ok")
    fixture.serve({ payloads: [dataFrom(ALICE, NOW + 1, { message: "one" })] })
    const other = openMirrorForWrite(fixture.paths.mirror)
    other.exec("DROP TABLE messages")
    other.close()

    const outcome = await fixture.run()

    expect(outcome).toEqual({ exitCode: 1, status: "failed", reason: STORAGE_REASON })
    expect(allGone(fixture.pids())).toBe(true)
  })
})
