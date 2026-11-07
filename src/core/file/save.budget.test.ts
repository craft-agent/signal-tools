import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildZip, type ZipEntry } from "../archive/zip.testing"
import { RESULT_BUDGET } from "../pages"
import { fitListings } from "./result"
import type { FileSaveOutput } from "./schema"
import { SENT, createSaveFixture, messageWithFiles, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

/** `count` small files with long names, so that their listing alone is over the budget when there are 500. */
function entries(count: number, prefix = "entry"): ZipEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${String(i).padStart(3, "0")}-${"n".repeat(100)}.txt`,
    data: "x",
  }))
}

describe("a result that is too long for the budget", () => {
  test("cuts the listing of a 500-entry archive to its first entries, and says so", async () => {
    t.store("big", buildZip(entries(500)))
    t.ingest(messageWithFiles(SENT, [{ id: "big", filename: "big.zip" }]))

    const result = await t.save(saveArgs())

    const listing = result.files[0]!.archive!
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESULT_BUDGET)
    expect(listing.entries_cut).toBe(true)
    expect(listing.entries.length).toBeGreaterThan(100)
    expect(listing.entries.length).toBeLessThan(500)
    expect(listing.entries[0]!.name.startsWith("entry-000-")).toBe(true)
    expect(listing.entries.at(-1)!.name).toContain(`entry-${String(listing.entries.length - 1).padStart(3, "0")}-`)
    expect(listing.files).toBe(500)
    expect(listing.total_size).toBe(500)
  })

  test("leaves a listing that fits whole, without entries_cut", async () => {
    t.store("small", buildZip(entries(20)))
    t.ingest(messageWithFiles(SENT, [{ id: "small", filename: "small.zip" }]))
    const listing = (await t.save(saveArgs())).files[0]!.archive!
    expect(listing.entries).toHaveLength(20)
    expect(listing.entries_cut).toBeUndefined()
  })

  test("still saves and describes everything else of the call", async () => {
    t.store("big", buildZip(entries(500)))
    t.store("plain", "text")
    t.ingest(
      messageWithFiles(SENT, [
        { id: "big", filename: "big.zip" },
        { id: "plain", filename: "plain.txt" },
      ]),
    )
    const result = await t.save(saveArgs())
    expect(result.files.map((file) => file.name)).toEqual(["big.zip", "plain.txt"])
    expect(result.note).toContain("never executable")
  })
})

describe("fitListings", () => {
  const listing = (count: number, name: string): NonNullable<FileSaveOutput["files"][number]["archive"]> => ({
    format: "zip",
    files: count,
    total_size: count,
    entries: Array.from({ length: count }, (_, i) => ({ name: `${name}-${i}-${"y".repeat(120)}`, size: 1 })),
  })
  const resultOf = (...archives: ReturnType<typeof listing>[]): FileSaveOutput => ({
    chat: "c",
    id: "i",
    folder: "/f",
    note: "n",
    files: archives.map((archive, i) => ({
      name: `a${i}.zip`,
      path: `/f/a${i}.zip`,
      size: 1,
      sha256: "0".repeat(64),
      archive,
    })),
  })

  test("changes nothing for a result within the budget", () => {
    const result = resultOf(listing(10, "a"))
    const before = JSON.stringify(result)
    expect(JSON.stringify(fitListings(result))).toBe(before)
  })

  test("cuts the largest listing first and keeps the smaller one whole when that is enough", () => {
    const result = fitListings(resultOf(listing(500, "big"), listing(5, "small")))
    const [big, small] = result.files.map((file) => file.archive!)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESULT_BUDGET)
    expect(big!.entries_cut).toBe(true)
    expect(small!.entries).toHaveLength(5)
    expect(small!.entries_cut).toBeUndefined()
  })

  test("cuts the next listing as well when the largest alone is not enough", () => {
    const result = fitListings(resultOf(listing(500, "one"), listing(500, "two")))
    const [one, two] = result.files.map((file) => file.archive!)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESULT_BUDGET)
    expect(one!.entries_cut).toBe(true)
    expect(two!.entries_cut).toBe(true)
    expect(one!.entries.length + two!.entries.length).toBeGreaterThan(100)
  })

  test("keeps the count of files and the total size, and the entries it keeps are the first ones", () => {
    const result = fitListings(resultOf(listing(500, "x")))
    const archive = result.files[0]!.archive!
    expect(archive.files).toBe(500)
    expect(archive.total_size).toBe(500)
    expect(archive.entries[0]!.name.startsWith("x-0-")).toBe(true)
    expect(archive.entries[1]!.name.startsWith("x-1-")).toBe(true)
  })
})

describe("what the sender chooses stays within the budget", () => {
  test("a declared content type is cut to 100 characters in the result, without splitting a character", async () => {
    t.store("a", "x")
    t.store("b", "y")
    t.ingest(
      messageWithFiles(SENT, [
        { id: "a", filename: "a.bin", contentType: `application/x-${"long".repeat(100)}` },
        { id: "b", filename: "b.bin", contentType: `${"t".repeat(99)}😀 and more` },
      ]),
    )
    const result = await t.save(saveArgs())
    expect(result.files[0]!.type).toBe(`application/x-${"long".repeat(100)}`.slice(0, 100))
    expect(result.files[0]!.type).toHaveLength(100)
    expect(result.files[1]!.type).toBe("t".repeat(99))
  })

  test("a short content type is kept as it is", async () => {
    t.store("a", "x")
    t.ingest(messageWithFiles(SENT, [{ id: "a", filename: "a.txt", contentType: "text/plain; charset=utf-8" }]))
    expect((await t.save(saveArgs())).files[0]!.type).toBe("text/plain; charset=utf-8")
  })

  test("a message of many archives with long names and types still fits, every listing cut as far as it takes", async () => {
    const zip = buildZip(entries(200))
    const attachments = Array.from({ length: 32 }, (_, i) => {
      t.store(`arc${i}`, zip)
      return {
        id: `arc${i}`,
        filename: `${String(i).padStart(2, "0")}-${"é".repeat(120)}.zip`,
        contentType: `application/${"z".repeat(400)}`,
      }
    })
    t.ingest(messageWithFiles(SENT, attachments))

    const result = await t.save(saveArgs())

    expect(result.files).toHaveLength(32)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESULT_BUDGET)
    expect(result.files.every((file) => file.type!.length === 100)).toBe(true)
    const cut = result.files.filter((file) => file.archive!.entries_cut)
    expect(cut.length).toBeGreaterThan(20)
    for (const file of result.files) expect(file.archive).toMatchObject({ files: 200, total_size: 200 })
  })
})
