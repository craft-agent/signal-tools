import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { ELF_BYTES, PE_BYTES } from "../archive/archive.testing"
import { DEFAULT_LIMITS } from "../archive/limits"
import { buildTar } from "../archive/tar.testing"
import { buildZip } from "../archive/zip.testing"
import {
  SENT,
  createSaveFixture,
  messageWithFiles,
  saveArgs,
  type SaveFixture,
  type TestAttachment,
} from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

async function save(attachments: TestAttachment[], contents: Record<string, Buffer | string>) {
  for (const [id, content] of Object.entries(contents)) t.store(id, content)
  t.ingest(messageWithFiles(SENT, attachments))
  return t.save(saveArgs())
}

describe("files that are refused", () => {
  test("a program is refused by its name, whatever its bytes", async () => {
    const result = await save([{ id: "a", filename: "setup.exe" }], { a: "harmless text" })
    expect(result.files).toEqual([])
    expect(result.refused).toEqual([{ name: "setup.exe", reason: "a program" }])
  })

  test.each([
    ["ELF", ELF_BYTES],
    ["PE", PE_BYTES],
  ])("%s bytes are refused under an innocent name and type", async (_label, bytes) => {
    const result = await save([{ id: "a", filename: "cat.png", contentType: "image/png" }], { a: bytes })
    expect(result.refused).toEqual([{ name: "cat.png", reason: "a program" }])
  })

  test("an installer, an app package and a macro document are refused with their reasons", async () => {
    const result = await save(
      [
        { id: "a", filename: "tool.msi" },
        { id: "b", filename: "game.apk" },
        { id: "c", filename: "budget.xlsm" },
      ],
      { a: "x", b: "x", c: "x" },
    )
    expect(result.refused!.map((item) => item.reason)).toEqual([
      "an installer",
      "an app package",
      "a document with macros",
    ])
  })

  test("a declared type can refuse a file too", async () => {
    const result = await save([{ id: "a", filename: "thing", contentType: "application/x-msdownload" }], { a: "x" })
    expect(result.refused).toEqual([{ name: "thing", reason: "a program" }])
  })

  test("source code is saved as text", async () => {
    const result = await save(
      [
        { id: "a", filename: "run.bat" },
        { id: "b", filename: "build.sh" },
        { id: "c", filename: "app.js" },
      ],
      { a: "@echo off", b: "#!/bin/sh\n", c: "1" },
    )
    expect(result.files.map((file) => file.name)).toEqual(["run.bat", "build.sh", "app.js"])
    expect(result.refused).toBeUndefined()
  })

  test("a refused file leaves nothing in the folder, and the others of the message are still saved", async () => {
    const result = await save(
      [
        { id: "a", filename: "evil.exe" },
        { id: "b", filename: "fine.txt" },
        { id: "c", filename: "trojan.png" },
      ],
      { a: "x", b: "fine", c: ELF_BYTES },
    )
    expect(result.files.map((file) => file.name)).toEqual(["fine.txt"])
    expect(result.refused!.map((item) => item.name)).toEqual(["evil.exe", "trojan.png"])
    expect(readdirSync(t.folder)).toEqual(["fine.txt"])
  })

  test("an archive that cannot be inspected is refused", async () => {
    const result = await save([{ id: "a", filename: "files.7z" }], { a: "x" })
    expect(result.refused![0]!.reason).toContain("cannot be inspected (7z)")
  })

  test("a file named as an archive that is not one is refused as mislabeled", async () => {
    const result = await save([{ id: "a", filename: "files.zip" }], { a: "plain text" })
    expect(result.refused![0]!.reason).toContain("mislabeled")
  })
})

describe("files the store does not have", () => {
  test("a file missing from the store is listed as missing, and the others are saved", async () => {
    t.store("here", "present")
    t.ingest(
      messageWithFiles(SENT, [
        { id: "gone", filename: "gone.txt" },
        { id: "here", filename: "here.txt" },
      ]),
    )
    const result = await t.save(saveArgs())
    expect(result.missing).toEqual([{ name: "gone.txt", reason: "not in the store" }])
    expect(result.files.map((file) => file.name)).toEqual(["here.txt"])
  })

  test.each(["../escape", "a/b", "/etc/passwd", ".hidden", "", "x".repeat(300), "a b", "a\u0000b"])(
    "an attachment id that is not a plain file name (%j) is never opened",
    async (id) => {
      t.store("escape", "outside the store")
      writeFileSync(join(t.stateDir, "default", "escape"), "state dir secret")
      t.ingest(messageWithFiles(SENT, [{ id, filename: "x.txt" }]))
      const result = await t.save(saveArgs())
      expect(result.files).toEqual([])
      expect(result.missing).toEqual([{ name: "x.txt", reason: "not in the store" }])
    },
  )

  test("a message file with no id is missing", async () => {
    t.ingest(messageWithFiles(SENT, [{ filename: "x.txt" }]))
    expect((await t.save(saveArgs())).missing).toEqual([{ name: "x.txt", reason: "not in the store" }])
  })

  test("a link in the store is not followed: the file is missing", async () => {
    const secret = join(t.stateDir, "secret.txt")
    writeFileSync(secret, "the keys")
    t.storeLink("link", secret)
    t.ingest(messageWithFiles(SENT, [{ id: "link", filename: "innocent.txt" }]))
    const result = await t.save(saveArgs())
    expect(result.missing).toEqual([{ name: "innocent.txt", reason: "not in the store" }])
    expect(readdirSync(t.folder)).toEqual([])
    expect(JSON.stringify(result)).not.toContain("the keys")
  })

  test("a folder in the store is not a file", async () => {
    mkdirSync(join(t.paths.attachments, "dir"))
    t.ingest(messageWithFiles(SENT, [{ id: "dir", filename: "d.txt" }]))
    expect((await t.save(saveArgs())).missing).toEqual([{ name: "d.txt", reason: "not in the store" }])
  })
})

describe("what a hostile archive does", () => {
  test("is refused with the reason and removed, not saved", async () => {
    const zip = buildZip([
      { name: "docs/readme.txt", data: "hi" },
      { name: "docs/run.sh.exe", data: "x" },
    ])
    const result = await save([{ id: "a", filename: "docs.zip" }], { a: zip })
    expect(result.files).toEqual([])
    expect(result.refused).toEqual([{ name: "docs.zip", reason: "the entry docs/run.sh.exe is a program" }])
    expect(readdirSync(t.folder)).toEqual([])
  })

  test.each([
    ["zip slip", [{ name: "../evil.txt", data: "x" }], "not a plain relative one"],
    ["an ELF under a plain name", [{ name: "data.bin", data: ELF_BYTES }], "is a program"],
    [
      "a nested archive",
      [{ name: "inner.zip", data: buildZip([{ name: "a", data: "b" }]) }],
      "archive inside the archive",
    ],
    ["a bundle", [{ name: "X.app/Contents/run", data: "#!/bin/sh" }], "app or system bundle"],
  ])("%s is refused and nothing is left", async (_label, entries, reason) => {
    const result = await save([{ id: "a", filename: "x.zip" }], { a: buildZip(entries) })
    expect(result.refused![0]!.reason).toContain(reason)
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("a zip bomb is refused by what it unpacks to, under a small limit, and nothing is left", async () => {
    const bomb = buildZip([{ name: "zeros.bin", data: Buffer.alloc(4_000_000) }])
    expect(bomb.length).toBeLessThan(10_000)
    t.store("a", bomb)
    t.ingest(messageWithFiles(SENT, [{ id: "a", filename: "bomb.zip" }]))

    const result = await t.save(saveArgs(), { host: { limits: { ...DEFAULT_LIMITS, maxTotalSize: 100 * 1024 } } })

    expect(result.files).toEqual([])
    expect(result.refused).toEqual([{ name: "bomb.zip", reason: "the archive unpacks to more than 102400 bytes" }])
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("a gzipped tar bomb is refused the same way", async () => {
    const bomb = gzipSync(buildTar([{ name: "zeros.bin", data: Buffer.alloc(4_000_000) }]))
    t.store("a", bomb)
    t.ingest(messageWithFiles(SENT, [{ id: "a", filename: "bomb.tar.gz" }]))
    const result = await t.save(saveArgs(), { host: { limits: { ...DEFAULT_LIMITS, maxTotalSize: 100 * 1024 } } })
    expect(result.refused![0]!.reason).toContain("unpacks to more than")
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("an archive that is large but within the limits is saved and listed", async () => {
    const big = buildZip([{ name: "zeros.bin", data: Buffer.alloc(2_000_000) }])
    t.store("a", big)
    t.ingest(messageWithFiles(SENT, [{ id: "a", filename: "big.zip" }]))
    const result = await t.save(saveArgs())
    expect(result.files[0]!.archive).toMatchObject({ format: "zip", files: 1, total_size: 2_000_000 })
    expect(readFileSync(join(t.folder, "big.zip")).length).toBe(big.length)
  })
})
