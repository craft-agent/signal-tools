import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../errors"
import { labelPaths } from "../signal/labels"
import { openMirrorForWrite, setMeta } from "../signal/mirror"
import {
  ACCOUNT_UUID_META,
  ERROR_META,
  LAST_RECEIVED_AT_META,
  REFRESHED_AT_META,
  STARTED_AT_META,
  STATUS_META,
  SUBSCRIBED_AT_META,
} from "../signal/mirror-meta"
import { MIRROR_VERSION } from "../signal/mirror-schema"
import { makeTempDir, ME, NOW, NUMBER } from "../signal/mirror.testing"
import { LINKED_ACCOUNT, writeSignalCliAccount } from "../signal/signal-cli.testing"
import { formatLocalTime } from "../time"
import { annotations, invoke } from "../tool"
import { signalAccountRead } from "./read"

let stateDir: string

beforeEach(() => {
  stateDir = makeTempDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function label(name = "default", registered: boolean | null | "absent" = true) {
  const paths = labelPaths(stateDir, name)
  mkdirSync(paths.dir)
  if (registered !== "absent") writeSignalCliAccount(paths.signalCli, LINKED_ACCOUNT, registered)
  return paths
}

function mirrorMeta(meta: Parameters<typeof setMeta>[1], name = "default", version = MIRROR_VERSION) {
  const paths = labelPaths(stateDir, name)
  const mirror = openMirrorForWrite(paths.mirror)
  try {
    setMeta(mirror, meta)
    mirror.exec(`PRAGMA user_version = ${version}`)
  } finally {
    mirror.close()
  }
}

function read(args: unknown = {}) {
  return invoke(signalAccountRead, args, { cwd: stateDir, stateDir })
}

async function failure(args: unknown) {
  try {
    await read(args)
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("Expected the call to fail")
}

describe("account read: linking and selection", () => {
  test("publishes read annotations", () => {
    expect(annotations(signalAccountRead)).toEqual({
      title: "Read account status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("no labels returns an empty list without creating state", async () => {
    rmSync(stateDir, { recursive: true })
    expect(await read()).toEqual({ accounts: [] })
    expect(existsSync(stateDir)).toBe(false)
  })

  test("not linked reports the linking step and null metadata", async () => {
    const paths = label("default", "absent")
    expect(await read()).toEqual({
      accounts: [
        {
          label: "default",
          linked: "not linked",
          service: "never run",
          last_received_at: null,
          subscribed_at: null,
          refreshed_at: null,
          error: null,
          action: "link",
          hint: "Link this device from the phone.",
        },
      ],
    })
    expect(existsSync(paths.mirror)).toBe(false)
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
  })

  test("an unregistered device needs linking again", async () => {
    label("default", false)
    const [account] = (await read()).accounts
    expect(account?.linked).toBe("unlinked")
    expect(account?.action).toBe("link")
    expect(account?.hint).toBe("Signal unlinked this device; link it again from the phone.")
  })

  test.each([true, null])("a linked device without a mirror needs the service (%s)", async (registered) => {
    label("default", registered)
    const [account] = (await read()).accounts
    expect(account?.linked).toBe("linked")
    expect(account?.service).toBe("never run")
    expect(account?.action).toBe("start_service")
  })

  test("lists sorted labels, or only the named label", async () => {
    label("zebra")
    label("alpha")
    expect((await read()).accounts.map((account) => account.label)).toEqual(["alpha", "zebra"])
    expect((await read({ account: "zebra" })).accounts.map((account) => account.label)).toEqual(["zebra"])
  })

  test("unknown account lists known labels as pickLabel does", async () => {
    label("default")
    const error = await failure({ account: "missing" })
    expect(error.code).toBe("not_found")
    expect(error.message).toBe('Signal account "missing" was not found; known accounts: default.')
  })

  test("unknown account with no labels says none is linked", async () => {
    const error = await failure({ account: "missing" })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("no Signal account is linked yet")
  })

  test.each([{ account: "../other" }, { account: "Bad" }, { account: 1 }, { extra: true }])(
    "refuses invalid arguments %j",
    async (args) => {
      expect((await failure(args)).code).toBe("invalid_argument")
    },
  )

  test("missing state directory is an entry-point bug", async () => {
    await expect(invoke(signalAccountRead, {}, { cwd: stateDir })).rejects.toMatchObject({ code: "internal_error" })
  })
})

describe("account read: service health", () => {
  test.each(["running", "starting"])("%s with a live lock is healthy", async (status) => {
    const paths = label()
    mirrorMeta({
      [STATUS_META]: status,
      [LAST_RECEIVED_AT_META]: NOW,
      [SUBSCRIBED_AT_META]: NOW - 1000,
      [REFRESHED_AT_META]: NOW - 2000,
    })
    writeFileSync(paths.syncLock, String(process.pid))
    const [account] = (await read()).accounts
    expect(account?.service).toBe(status)
    expect(account?.action).toBeNull()
    expect(account?.hint).toBeNull()
    expect(account?.last_received_at).toBe(formatLocalTime(NOW))
    expect(account?.subscribed_at).toBe(formatLocalTime(NOW - 1000))
    expect(account?.refreshed_at).toBe(formatLocalTime(NOW - 2000))
    expect(account?.last_received_at).toMatch(/\.\d{3}[+-]\d{2}:\d{2}$/)
    expect(Date.parse(account?.last_received_at ?? "")).toBe(NOW)
  })

  test.each(["running", "starting"])("%s with a dead lock is not running", async (status) => {
    const paths = label()
    mirrorMeta({ [STATUS_META]: status })
    writeFileSync(paths.syncLock, "2147483647")
    const [account] = (await read()).accounts
    expect(account?.service).toBe("not running")
    expect(account?.action).toBe("start_service")
  })

  test("a missing lock corrects a running status", async () => {
    label()
    mirrorMeta({ [STATUS_META]: "running" })
    expect((await read()).accounts[0]?.service).toBe("not running")
  })

  test("failed reports the recorded error and asks to check the service log", async () => {
    label()
    mirrorMeta({ [STATUS_META]: "failed", [ERROR_META]: "The daemon stopped unexpectedly." })
    const [account] = (await read()).accounts
    expect(account?.service).toBe("failed")
    expect(account?.error).toBe("The daemon stopped unexpectedly.")
    expect(account?.action).toBe("check_service")
    expect(account?.hint).toContain("log")
  })

  test("stopped needs the service started", async () => {
    label()
    mirrorMeta({ [STATUS_META]: "stopped" })
    const [account] = (await read()).accounts
    expect(account?.service).toBe("stopped")
    expect(account?.action).toBe("start_service")
  })

  test("mirror unlinked overrides an account still marked registered", async () => {
    const paths = label()
    const beforeRun = new Date(NOW - 1000)
    utimesSync(join(paths.signalCli, "data", "accounts.json"), beforeRun, beforeRun)
    mirrorMeta({ [STATUS_META]: "unlinked", [STARTED_AT_META]: NOW })
    const [account] = (await read()).accounts
    expect(account?.linked).toBe("unlinked")
    expect(account?.service).toBe("stopped")
    expect(account?.action).toBe("link")
  })

  test.each([NOW, null])(
    "fresh registered data overrides mirror unlinked after relinking (started_at: %s)",
    async (startedAt) => {
      const paths = label()
      const afterRun = new Date(NOW + 1000)
      utimesSync(join(paths.signalCli, "data", "accounts.json"), afterRun, afterRun)
      mirrorMeta({ [STATUS_META]: "unlinked", [STARTED_AT_META]: startedAt })
      const [account] = (await read()).accounts
      expect(account?.linked).toBe("linked")
      expect(account?.service).toBe("stopped")
      expect(account?.action).toBe("start_service")
    },
  )

  test("a newer mirror reports the refusal and restart action", async () => {
    label()
    mirrorMeta({}, "default", MIRROR_VERSION + 1)
    const [account] = (await read()).accounts
    expect(account?.service).toBe("failed")
    expect(account?.error).toContain("newer version")
    expect(account?.action).toBe("start_service")
  })

  test("an uninitialized mirror is treated as never run", async () => {
    label()
    mirrorMeta({}, "default", 0)
    const [account] = (await read()).accounts
    expect(account?.service).toBe("never run")
    expect(account?.error).toBeNull()
    expect(account?.action).toBe("start_service")
  })

  test("number, uuid and content never appear in the JSON", async () => {
    const paths = label()
    const mirror = openMirrorForWrite(paths.mirror)
    setMeta(mirror, { [ACCOUNT_UUID_META]: ME, [STATUS_META]: "stopped" })
    mirror
      .prepare("INSERT INTO contacts (uuid, name, number, updated) VALUES (?, ?, ?, ?)")
      .run(ME, "private contact text", NUMBER, NOW)
    mirror.close()
    const json = JSON.stringify(await read())
    for (const secret of [ME, NUMBER, "private contact text"]) expect(json).not.toContain(secret)
  })

  test("reading leaves the mirror's mtime and size unchanged, with no WAL left behind", async () => {
    const paths = label()
    mirrorMeta({ [STATUS_META]: "stopped" })
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
    const before = statSync(paths.mirror)
    await read()
    const after = statSync(paths.mirror)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
  })
})
