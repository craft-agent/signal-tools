import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeServiceLog } from "./service"
import type { ServiceHost } from "./service-types"

const ID = "io.github.craft-agent.signal-tools"

let home: string
let logDir: string

function hostOn(platform: NodeJS.Platform): ServiceHost {
  return {
    platform,
    home,
    uid: 501,
    env: {},
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sig-log-"))
  logDir = join(home, "Library", "Logs", ID)
  await mkdir(logDir, { recursive: true })
})

afterEach(() => rm(home, { recursive: true, force: true }))

describe("removeServiceLog", () => {
  test("deletes the log and the then empty directory", async () => {
    await writeFile(join(logDir, "work.log"), "x")
    await removeServiceLog(ID, "work", hostOn("darwin"))
    expect(await exists(logDir)).toBe(false)
  })

  test("keeps the directory while another label's log is in it", async () => {
    await writeFile(join(logDir, "work.log"), "x")
    await writeFile(join(logDir, "home.log"), "y")
    await removeServiceLog(ID, "work", hostOn("darwin"))
    expect(await exists(join(logDir, "work.log"))).toBe(false)
    expect(await readFile(join(logDir, "home.log"), "utf8")).toBe("y")
  })

  test("leaves a link at the log path alone and does not follow it", async () => {
    const target = join(home, "precious.txt")
    await writeFile(target, "keep")
    await symlink(target, join(logDir, "work.log"))
    await removeServiceLog(ID, "work", hostOn("darwin"))
    expect(await readFile(target, "utf8")).toBe("keep")
    expect(await exists(join(logDir, "work.log"))).toBe(true)
  })

  test("is fine without a log, or without the directory", async () => {
    await removeServiceLog(ID, "work", hostOn("darwin"))
    expect(await exists(logDir)).toBe(false)
    await removeServiceLog(ID, "work", hostOn("darwin"))
  })

  test("leaves a file where the directory should be alone, without failing", async () => {
    await rm(logDir, { recursive: true })
    await writeFile(logDir, "not a directory")
    await removeServiceLog(ID, "work", hostOn("darwin"))
    expect(await readFile(logDir, "utf8")).toBe("not a directory")
  })

  test("does nothing off macOS", async () => {
    await writeFile(join(logDir, "work.log"), "x")
    await removeServiceLog(ID, "work", hostOn("linux"))
    expect(await exists(join(logDir, "work.log"))).toBe(true)
  })
})
