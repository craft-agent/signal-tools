import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { labelPaths } from "../signal/labels"
import { openMirrorForWrite, setMeta } from "../signal/mirror"
import { STATUS_META } from "../signal/mirror-meta"
import { MIRROR_VERSION } from "../signal/mirror-schema"
import { makeTempDir } from "../signal/mirror.testing"
import { writeServiceRecord } from "../signal/service-record"
import { LINKED_ACCOUNT, writeSignalCliAccount } from "../signal/signal-cli.testing"
import { invoke } from "../tool"
import { signalAccountRead } from "./read"

const START_HINT = "Start the sync service to receive messages for this account."
const GONE_HINT =
  "The program the sync service was installed with is gone, as after an update; install the service again."
const RUNNING_GONE_HINT =
  "The sync service has not stopped, but the program it was installed with is gone, so it will not start again; install the service again."

let stateDir: string
let filesDir: string

beforeEach(() => {
  stateDir = makeTempDir()
  filesDir = mkdtempSync(join(tmpdir(), "service-files-"))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(filesDir, { recursive: true, force: true })
})

function label(registered: boolean | "absent" = true) {
  const paths = labelPaths(stateDir, "default")
  mkdirSync(paths.dir)
  if (registered !== "absent") writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, registered)
  return paths
}

function mirrorStatus(status: string) {
  const mirror = openMirrorForWrite(labelPaths(stateDir, "default").mirror)
  try {
    setMeta(mirror, { [STATUS_META]: status })
    mirror.exec(`PRAGMA user_version = ${MIRROR_VERSION}`)
  } finally {
    mirror.close()
  }
}

/** Writes a record whose files exist unless named in `missing`. */
async function record(paths: ReturnType<typeof label>, missing: Array<"program" | "script"> = []) {
  const program = join(filesDir, "program")
  const script = join(filesDir, "script.js")
  if (!missing.includes("program")) writeFileSync(program, "")
  if (!missing.includes("script")) writeFileSync(script, "")
  await writeServiceRecord(paths, { program, script })
  return { program, script }
}

async function read() {
  const [account] = (await invoke(signalAccountRead, {}, { cwd: stateDir, stateDir })).accounts
  return account
}

describe("account read: service record", () => {
  test("a record with both files present changes nothing", async () => {
    const paths = label()
    mirrorStatus("stopped")
    await record(paths)
    const account = await read()
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(START_HINT)
  })

  test("no record changes nothing", async () => {
    label()
    mirrorStatus("stopped")
    const account = await read()
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(START_HINT)
  })

  test.each<"program" | "script">(["program", "script"])("a stopped service with the %s gone", async (gone) => {
    const paths = label()
    mirrorStatus("stopped")
    await record(paths, [gone])
    const account = await read()
    expect(account?.service).toBe("stopped")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test("a running service whose program is gone will not start again", async () => {
    const paths = label()
    mirrorStatus("running")
    writeFileSync(paths.syncLock, String(process.pid))
    await record(paths, ["program"])
    const account = await read()
    expect(account?.service).toBe("running")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(RUNNING_GONE_HINT)
  })

  test("a running service with its files present needs nothing", async () => {
    const paths = label()
    mirrorStatus("running")
    writeFileSync(paths.syncLock, String(process.pid))
    await record(paths)
    const account = await read()
    expect(account?.action).toBeNull()
    expect(account?.hint).toBeNull()
  })

  test("a gone program wins over a failed service", async () => {
    const paths = label()
    mirrorStatus("failed")
    await record(paths, ["program"])
    const account = await read()
    expect(account?.service).toBe("failed")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test("a gone program wins over a refused mirror, which a restart could not fix", async () => {
    const paths = label()
    mirrorStatus("stopped")
    const mirror = openMirrorForWrite(paths.mirror)
    try {
      mirror.exec(`PRAGMA user_version = ${MIRROR_VERSION + 1}`)
    } finally {
      mirror.close()
    }
    await record(paths, ["program"])
    const account = await read()
    expect(account?.error).not.toBeNull()
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test.each([false, "absent" as const])("linking still comes first (registered: %s)", async (registered) => {
    const paths = label(registered)
    await record(paths, ["program"])
    const account = await read()
    expect(account?.action).toBe("link")
  })

  test("the result never contains the record's paths", async () => {
    const paths = label()
    mirrorStatus("stopped")
    const files = await record(paths, ["program"])
    const json = JSON.stringify(await read())
    for (const path of [files.program, files.script, filesDir]) expect(json).not.toContain(path)
  })
})
