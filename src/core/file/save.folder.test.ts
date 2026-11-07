import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ALICE } from "../signal/mirror.testing"
import { writeTargets } from "../targets"
import { createFileSave } from "./save"
import { MESSAGE_ID, SENT, createSaveFixture, messageWithFiles, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
  t.store("att", "payload")
  t.ingest(messageWithFiles(SENT, [{ id: "att", filename: "report.txt" }]))
})
afterEach(() => t.close())

describe("the download directory", () => {
  test("is required: an entry point that supplied none is an internal_error", async () => {
    const error = await t.failure(saveArgs(), { ctx: { downloadDir: undefined } })
    expect(error).toMatchObject({ code: "internal_error", message: expect.stringContaining("download directory") })
  })

  test("may not be inside the state directory, named by the setting", async () => {
    const downloadDir = join(t.stateDir, "downloads")
    const error = await t.failure(saveArgs(), { ctx: { downloadDir } })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("download_dir")
    expect(error.message).toContain("state directory")
    expect(existsSync(downloadDir)).toBe(false)
  })

  test("may not be the state directory, or the label's own folder in it", async () => {
    for (const downloadDir of [t.stateDir, join(t.stateDir, "default"), t.paths.attachments]) {
      expect((await t.failure(saveArgs(), { ctx: { downloadDir } })).code).toBe("invalid_argument")
    }
  })

  test("may not reach the state directory through a link", async () => {
    const link = join(t.downloadDir, "link-to-state")
    symlinkSync(t.stateDir, link)
    const error = await t.failure(saveArgs(), { ctx: { downloadDir: join(link, "files") } })
    expect(error.code).toBe("invalid_argument")
    expect(readdirSync(t.stateDir)).not.toContain("files")
  })

  test("may not be inside the tools' own directory", async () => {
    const own = join(t.downloadDir, "installed")
    mkdirSync(own)
    const error = await t.failure(saveArgs(), { ctx: { ownDir: own, downloadDir: join(own, "dist", "files") } })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("download_dir")
    expect(existsSync(join(own, "dist"))).toBe(false)
  })

  test("may be a link to a folder elsewhere: its real path is what counts", async () => {
    const real = join(t.downloadDir, "real")
    mkdirSync(real)
    const link = join(t.downloadDir, "link")
    symlinkSync(real, link)
    const result = await t.save(saveArgs(), { ctx: { downloadDir: link } })
    expect(result.folder).toBe(join(real, "default", `${SENT}-${ALICE}`))
    expect(readFileSync(join(result.folder, "report.txt"), "utf8")).toBe("payload")
  })

  test("a file where the download directory should be is invalid_argument", async () => {
    const file = join(t.downloadDir, "afile")
    writeFileSync(file, "x")
    expect((await t.failure(saveArgs(), { ctx: { downloadDir: join(file, "sub") } })).code).toBe("invalid_argument")
  })
})

describe("links below the download directory are never followed", () => {
  test("a link where the label's folder belongs is refused, and nothing is written through it", async () => {
    const elsewhere = join(t.downloadDir, "elsewhere")
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(t.downloadDir, "default"))
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("a link")
    expect(readdirSync(elsewhere)).toEqual([])
  })

  test("a link where the message's folder belongs is refused", async () => {
    const elsewhere = join(t.downloadDir, "elsewhere")
    mkdirSync(elsewhere)
    mkdirSync(join(t.downloadDir, "default"))
    symlinkSync(elsewhere, t.folder)
    expect((await t.failure(saveArgs())).code).toBe("invalid_argument")
    expect(readdirSync(elsewhere)).toEqual([])
  })

  test("a file where the message's folder belongs is refused", async () => {
    mkdirSync(join(t.downloadDir, "default"))
    writeFileSync(t.folder, "not a folder")
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("invalid_argument")
    expect(readFileSync(t.folder, "utf8")).toBe("not a folder")
  })

  test("a link planted at the file's name is not written through: the file is numbered", async () => {
    const victim = join(t.downloadDir, "victim.txt")
    writeFileSync(victim, "keep me")
    mkdirSync(t.folder, { recursive: true })
    symlinkSync(victim, join(t.folder, "report.txt"))

    const result = await t.save(saveArgs())

    expect(readFileSync(victim, "utf8")).toBe("keep me")
    expect(result.files[0]!.name).toBe("report (2).txt")
    expect(readFileSync(join(t.folder, "report (2).txt"), "utf8")).toBe("payload")
  })

  test("a dangling link at the file's name is not followed either", async () => {
    mkdirSync(t.folder, { recursive: true })
    const target = join(t.downloadDir, "not-there.txt")
    symlinkSync(target, join(t.folder, "report.txt"))
    const result = await t.save(saveArgs())
    expect(existsSync(target)).toBe(false)
    expect(result.files[0]!.name).toBe("report (2).txt")
  })

  test("an existing folder of the right kind is reused and keeps its mode", async () => {
    mkdirSync(t.folder, { recursive: true, mode: 0o750 })
    await t.save(saveArgs())
    expect(statSync(t.folder).mode & 0o777).toBe(0o750)
  })
})

describe("what a call will write to", () => {
  const spec = createFileSave()
  const ctx = () => ({ cwd: t.stateDir, stateDir: t.stateDir, downloadDir: t.downloadDir })

  test("is the message's folder, and nothing is made to find out", async () => {
    expect(await writeTargets(spec, saveArgs(), ctx())).toEqual([t.folder])
    expect(readdirSync(t.downloadDir)).toEqual([])
  })

  test("is the same folder for the same message however it is asked for", async () => {
    expect(await writeTargets(spec, saveArgs({ unpack: true, account: "default" }), ctx())).toEqual([t.folder])
    expect(MESSAGE_ID).toBe(`${ALICE}:${SENT}`)
  })

  test("is * when the download directory, the state directory, the label or the id cannot be told", async () => {
    expect(await writeTargets(spec, saveArgs(), { ...ctx(), downloadDir: undefined })).toEqual(["*"])
    expect(await writeTargets(spec, saveArgs(), { ...ctx(), stateDir: undefined })).toEqual(["*"])
    expect(await writeTargets(spec, saveArgs({ account: "nobody" }), ctx())).toEqual(["*"])
    expect(await writeTargets(spec, saveArgs({ id: "nope" }), ctx())).toEqual(["*"])
    expect(await writeTargets(spec, { chat: ALICE }, ctx())).toEqual(["*"])
  })

  test("is * when the path holds a wildcard", async () => {
    expect(await writeTargets(spec, saveArgs(), { ...ctx(), downloadDir: join(t.downloadDir, "dl*") })).toEqual(["*"])
  })
})
