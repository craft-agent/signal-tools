import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../errors"
import { failureOf } from "./daemon.testing"
import { ACCOUNT_UUID_META, readLinkedAccount } from "./account"
import { ensureLabelDir } from "./labels"
import { linkingFixture, STRAY_VARIABLE, type LinkingFixture } from "./linking.testing"
import { openMirrorForWrite, setMeta } from "./mirror"
import { ALICE, ME } from "./mirror.testing"
import { LINKED_ACCOUNT, writeSignalCliAccount, type FakeMode } from "./signal-cli.testing"

let fixtures: LinkingFixture[] = []

function fixture(mode: FakeMode): LinkingFixture {
  const made = linkingFixture(mode)
  fixtures.push(made)
  return made
}

afterEach(() => {
  setSystemTime()
  for (const made of fixtures) made.close()
  fixtures = []
})

/** Gives the label a mirror whose history belongs to `account`, or to none. */
async function writeMirror(t: LinkingFixture, account: string | null): Promise<void> {
  await ensureLabelDir(t.stateDir, t.paths.label)
  const mirror = openMirrorForWrite(t.paths.mirror)
  if (account !== null) setMeta(mirror, { [ACCOUNT_UUID_META]: account })
  mirror.close()
}

describe("linkDevice", () => {
  test("links the label, hands over the address once and never lets the number out", async () => {
    const t = fixture("link-ok")
    const result = await t.link()

    expect(result).toEqual({ label: "main" })
    expect(t.uris).toEqual(["sgnl://linkdevice?uuid=fake-device&pub_key=fake-key"])
    expect(readLinkedAccount(t.paths)).toEqual({ ...LINKED_ACCOUNT, registered: true })
    expect(JSON.stringify([result, t.uris, t.logs])).not.toContain(LINKED_ACCOUNT.number)
    expect(t.logs).toEqual(["INFO Waiting for [number] to scan the code"])
    expect(statSync(t.paths.dir).mode & 0o777).toBe(0o700)
  })

  test("runs signal-cli on the label's directory with the device name and a filtered environment", async () => {
    const t = fixture("link-ok")
    await t.link({ deviceName: "Rock & Roll" })

    const [call, ...others] = t.fake.calls()
    expect(others).toEqual([])
    expect(call?.config).toBe(t.paths.signalCli)
    expect(call?.args).toEqual(["link", "-n", "Rock & Roll"])
    expect(call?.env).toContain("PATH")
    expect(call?.env).not.toContain(STRAY_VARIABLE)
  })

  test("refuses a label that is still linked and starts nothing", async () => {
    const t = fixture("link-ok")
    writeSignalCliAccount(t.paths.signalCli, LINKED_ACCOUNT)

    const error = await failureOf(t.link())
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(error.message).toBe(
      "This label is still linked. To link it again, remove this device on the phone (Settings > Linked devices) first, or remove the label.",
    )
    expect(t.fake.calls()).toEqual([])
    expect(readLinkedAccount(t.paths)?.registered).toBe(true)
  })

  test("refuses a label whose registration the keys file does not state", async () => {
    const t = fixture("link-ok")
    writeSignalCliAccount(t.paths.signalCli, LINKED_ACCOUNT, null)
    expect(((await failureOf(t.link())) as ToolError).code).toBe("invalid_argument")
    expect(t.fake.calls()).toEqual([])
  })

  test("moves the keys of an unlinked device aside, keeps the mirror and links again", async () => {
    const t = fixture("link-ok")
    writeSignalCliAccount(t.paths.signalCli, LINKED_ACCOUNT, false)
    await writeMirror(t, ME)

    const result = await t.link()

    expect(result.movedAside).toMatch(new RegExp(`^${t.paths.signalCli}\\.unlinked-\\d{14}$`))
    expect(existsSync(join(result.movedAside!, "data", "accounts.json"))).toBe(true)
    expect(readLinkedAccount(t.paths)?.registered).toBe(true)
    expect(existsSync(t.paths.mirror)).toBe(true)
  })

  test("names the moved keys by the local time and counts up when the name is taken", async () => {
    const t = fixture("link-ok")
    setSystemTime(new Date(2026, 10, 7, 9, 5, 3))
    const stamped = `${t.paths.signalCli}.unlinked-20261107090503`
    writeSignalCliAccount(t.paths.signalCli, LINKED_ACCOUNT, false)
    mkdirSync(stamped)
    mkdirSync(`${stamped}-2`)

    expect((await t.link()).movedAside).toBe(`${stamped}-3`)
  })

  test("keeps history that belongs to the same account", async () => {
    const t = fixture("link-ok")
    await writeMirror(t, ME)
    expect(await t.link()).toEqual({ label: "main" })
  })

  test("treats a mirror that was never set up, or names no account, as no history", async () => {
    const t = fixture("link-ok")
    await writeMirror(t, null)
    await t.link()
    expect(readLinkedAccount(t.paths)?.registered).toBe(true)

    const never = fixture("link-ok")
    await ensureLabelDir(never.stateDir, never.paths.label)
    writeFileSync(never.paths.mirror, "")
    await never.link()
    expect(readLinkedAccount(never.paths)?.registered).toBe(true)
  })

  test("removes the new keys when the phone holds another account than the label's history", async () => {
    const t = fixture("link-ok")
    await writeMirror(t, ALICE)

    const error = await failureOf(t.link())

    expect((error as ToolError).code).toBe("invalid_argument")
    expect(error.message).toBe(
      "The phone that scanned the code holds a different account than this label's history. Remove this device from that phone's Linked devices, then link it under another label.",
    )
    expect(existsSync(t.paths.signalCli)).toBe(false)
    expect(existsSync(t.paths.mirror)).toBe(true)
    expect(error.message).not.toContain(LINKED_ACCOUNT.number)
  })

  test("removes only the new keys and leaves the moved-aside ones alone", async () => {
    const t = fixture("link-other")
    writeSignalCliAccount(t.paths.signalCli, LINKED_ACCOUNT, false)
    await writeMirror(t, ME)

    expect(((await failureOf(t.link())) as ToolError).code).toBe("invalid_argument")
    expect(readdirSync(t.paths.dir).filter((name) => name.startsWith("signal-cli.unlinked-"))).toHaveLength(1)
    expect(existsSync(t.paths.signalCli)).toBe(false)
  })
})
