import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildZip } from "../archive/zip.testing"
import { ALICE } from "../signal/mirror.testing"
import { CANCELLED_MESSAGE } from "./constants"
import { QUARANTINE_ATTRIBUTE, XATTR } from "./quarantine"
import {
  SENT,
  abortAfter,
  abortWhen,
  createSaveFixture,
  messageWithFiles,
  saveArgs,
  type SaveFixture,
} from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
  for (const id of ["a", "b", "c"]) t.store(id, `content of ${id}`)
  t.ingest(
    messageWithFiles(SENT, [
      { id: "a", filename: "one.txt" },
      { id: "b", filename: "two.txt" },
      { id: "c", filename: "three.txt" },
    ]),
  )
})
afterEach(() => t.close())

const darwin = { platform: "darwin" as const }
const leftovers = () => readdirSync(t.folder).filter((name) => name.startsWith("."))

describe("a cancellation once something is saved", () => {
  test("ends the work but not the call: what was saved is listed, with errors.cancelled", async () => {
    // one check before the first file, two while it is copied; the second file's check is the fourth
    const result = await t.save(saveArgs(), { ctx: { signal: abortAfter(3) } })

    expect(result.files.map((file) => file.name)).toEqual(["one.txt"])
    expect(result.errors).toEqual({ cancelled: CANCELLED_MESSAGE })
    expect(readdirSync(t.folder)).toEqual(["one.txt"])
  })

  test("still marks what was placed, without the call's signal", async () => {
    const result = await t.save(saveArgs(), { host: darwin, ctx: { signal: abortAfter(3) } })
    expect(t.runs).toEqual([
      [XATTR, "-w", QUARANTINE_ATTRIBUTE, expect.stringMatching(/^0081;/), join(t.folder, "one.txt")],
    ])
    expect(result.errors).toEqual({ cancelled: CANCELLED_MESSAGE })
  })

  test("a cancellation in the middle of copying a file leaves no partial file", async () => {
    // the first file is saved (three checks), then the second is stopped at its first chunk
    const result = await t.save(saveArgs(), { ctx: { signal: abortAfter(4) } })
    expect(result.files.map((file) => file.name)).toEqual(["one.txt"])
    expect(result.errors!.cancelled).toBe(CANCELLED_MESSAGE)
    expect(leftovers()).toEqual([])
    expect(readdirSync(t.folder)).toEqual(["one.txt"])
  })

  test("lists the errors of other steps beside it", async () => {
    const run = async () => ({ code: 1, stdout: "", stderr: "nope" })
    const result = await t.save(saveArgs(), { host: { ...darwin, run }, ctx: { signal: abortAfter(3) } })
    expect(Object.keys(result.errors!).sort()).toEqual(["cancelled", "quarantine"])
  })

  test("a file that was already saved counts as saved", async () => {
    await t.save(saveArgs())
    const result = await t.save(saveArgs(), { ctx: { signal: abortAfter(3) } })
    expect(result.files).toMatchObject([{ name: "one.txt", already_saved: true }])
    expect(result.errors).toEqual({ cancelled: CANCELLED_MESSAGE })
  })

  test("during an unpack leaves the archive saved and nothing half unpacked", async () => {
    t.store(
      "z",
      buildZip([
        { name: "d/f.txt", data: "x".repeat(5000) },
        { name: "g.txt", data: "y" },
      ]),
    )
    t.ingest(messageWithFiles(SENT + 1, [{ id: "z", filename: "pack.zip" }]))
    const folder = join(t.downloadDir, "default", `${SENT + 1}-${ALICE}`)
    // cancelled as soon as unpacking has written something below its staging folder
    const signal = abortWhen(() => {
      if (!existsSync(folder)) return false
      return readdirSync(folder).some(
        (name) => name.endsWith(".unpacking") && readdirSync(join(folder, name)).length > 0,
      )
    })

    const result = await t.save(saveArgs({ id: `${ALICE}:${SENT + 1}`, unpack: true }), {
      host: darwin,
      ctx: { signal },
    })

    expect(result.files.map((file) => [file.name, file.unpacked])).toEqual([["pack.zip", undefined]])
    expect(result.errors).toEqual({ cancelled: CANCELLED_MESSAGE })
    expect(readdirSync(folder)).toEqual(["pack.zip"])
    expect(t.runs).toHaveLength(1)
  })
})

describe("a cancellation before anything is saved", () => {
  test("throws, as before, and leaves nothing in the folder", async () => {
    await expect(t.save(saveArgs(), { ctx: { signal: abortAfter(0) } })).rejects.toMatchObject({ name: "AbortError" })
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("throws for a real aborted signal too", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(t.save(saveArgs(), { ctx: { signal: controller.signal } })).rejects.toMatchObject({
      name: "AbortError",
    })
  })

  test("throws when it comes while the first file is being copied, and removes the partial", async () => {
    await expect(t.save(saveArgs(), { ctx: { signal: abortAfter(1) } })).rejects.toMatchObject({ name: "AbortError" })
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("throws even when files were refused or missing, since none was saved", async () => {
    t.store("exe", "x")
    t.ingest(
      messageWithFiles(SENT + 5, [
        { id: "exe", filename: "tool.exe" },
        { id: "gone", filename: "g.txt" },
        { id: "a", filename: "x.txt" },
      ]),
    )
    // checks: before file 1 (1), file 1 refused after copying (2), before file 2 (3), before file 3 (4), copying (5)
    const id = `${ALICE}:${SENT + 5}`
    await expect(t.save(saveArgs({ id }), { ctx: { signal: abortAfter(4) } })).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})
