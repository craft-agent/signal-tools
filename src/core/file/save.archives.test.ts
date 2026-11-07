import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { buildTar } from "../archive/tar.testing"
import { buildZip } from "../archive/zip.testing"
import { SENT, createSaveFixture, messageWithFiles, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

async function saveArchive(filename: string, bytes: Buffer, contentType?: string) {
  t.store("arc", bytes)
  t.ingest(messageWithFiles(SENT, [{ id: "arc", filename, contentType }]))
  return t.save(saveArgs())
}

const zip = () =>
  buildZip([
    { name: "docs", dir: true },
    { name: "docs/readme.txt", data: "hello" },
    { name: "image.bin", data: Buffer.alloc(100, 7) },
  ])

describe("an archive among the files", () => {
  test("a zip is saved whole and listed, not unpacked", async () => {
    const result = await saveArchive("pack.zip", zip(), "application/zip")
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.archive).toEqual({
      format: "zip",
      files: 2,
      total_size: 105,
      entries: [
        { name: "docs/", size: 0, dir: true },
        { name: "docs/readme.txt", size: 5 },
        { name: "image.bin", size: 100 },
      ],
    })
    expect(result.files[0]!.unpacked).toBeUndefined()
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
  })

  test("a tar and a gzipped tar are listed too", async () => {
    const tar = buildTar([{ name: "a.txt", data: "abc" }])
    const plain = await saveArchive("pack.tar", tar)
    expect(plain.files[0]!.archive).toMatchObject({ format: "tar", files: 1, total_size: 3 })
    t.close()
    t = createSaveFixture()
    const gz = await saveArchive("pack.tar.gz", gzipSync(tar))
    expect(gz.files[0]!.archive).toMatchObject({ format: "tgz", files: 1, total_size: 3 })
  })

  test("names in the listing are cleaned of invisible characters", async () => {
    const result = await saveArchive("pack.zip", buildZip([{ name: "pay\u200Bment.txt", data: "x" }]))
    expect(result.files[0]!.archive!.entries[0]!.name).toBe("pay?ment.txt")
  })

  test("an empty archive is saved and lists nothing", async () => {
    const result = await saveArchive("empty.zip", buildZip([]))
    expect(result.files[0]!.archive).toEqual({ format: "zip", files: 0, total_size: 0, entries: [] })
  })

  test("an archive saved before is reused, still listed", async () => {
    await saveArchive("pack.zip", zip())
    const again = await t.save(saveArgs())
    expect(again.files[0]).toMatchObject({ already_saved: true, archive: { format: "zip", files: 2 } })
  })

  test("an office document is a file: saved whole, not listed or unpacked", async () => {
    const docx = buildZip([
      { name: "word/document.xml", data: "<w/>" },
      { name: "embedded.zip", data: buildZip([]) },
    ])
    const result = await saveArchive("letter.docx", docx)
    expect(result.files[0]!.archive).toBeUndefined()
    const unpacked = await t.save(saveArgs({ unpack: true }))
    expect(unpacked.files[0]!.unpacked).toBeUndefined()
    expect(existsSync(join(t.folder, "letter.docx.unpacked"))).toBe(false)
  })

  test("an archive saved under another name than the one it was sent with is judged by the new name", async () => {
    const result = await saveArchive("CON.zip", zip())
    expect(result.files[0]!.name).toBe("_CON.zip")
    expect(result.files[0]!.archive).toBeDefined()
  })
})
