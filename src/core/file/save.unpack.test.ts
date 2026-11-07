import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { createFixtures, type Fixtures } from "../archive/archive.testing"
import { buildTar } from "../archive/tar.testing"
import { buildZip } from "../archive/zip.testing"
import { unpackArchive } from "./unpack"
import { SENT, abortWhen, createSaveFixture, messageWithFiles, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

const zip = () =>
  buildZip([
    { name: "top.txt", data: "top" },
    { name: "docs", dir: true },
    { name: "docs/readme.txt", data: "hello" },
    { name: "deep/er/data.bin", data: Buffer.from([1, 2, 3]) },
    { name: "empty-dir", dir: true },
  ])

async function saveWith(bytes: Buffer, filename = "pack.zip", unpack = true) {
  t.store("arc", bytes)
  t.ingest(messageWithFiles(SENT, [{ id: "arc", filename }]))
  return t.save(saveArgs({ unpack }))
}

const mode = (path: string) => statSync(path).mode & 0o777
const leftovers = (folder: string) => readdirSync(folder).filter((name) => name.startsWith("."))

/** Every path below a folder, folders with a trailing slash. */
function tree(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(root, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
}

describe("unpacking a saved archive", () => {
  test("writes the tree beside the archive, folders 0700 and files 0600", async () => {
    const result = await saveWith(zip())
    const target = join(t.folder, "pack.zip.unpacked")
    expect(result.files[0]!.unpacked).toBe(target)
    expect(result.files[0]!.already_unpacked).toBeUndefined()
    expect(tree(target)).toEqual([
      "deep/",
      "deep/er/",
      "deep/er/data.bin",
      "docs/",
      "docs/readme.txt",
      "empty-dir/",
      "top.txt",
    ])
    expect(readFileSync(join(target, "docs", "readme.txt"), "utf8")).toBe("hello")
    expect([...readFileSync(join(target, "deep", "er", "data.bin"))]).toEqual([1, 2, 3])
    for (const folder of [target, join(target, "deep"), join(target, "deep", "er"), join(target, "empty-dir")]) {
      expect(mode(folder)).toBe(0o700)
    }
    for (const file of ["top.txt", "docs/readme.txt", "deep/er/data.bin"]) expect(mode(join(target, file))).toBe(0o600)
    expect(leftovers(t.folder)).toEqual([])
    expect(readdirSync(t.folder).sort()).toEqual(["pack.zip", "pack.zip.unpacked"])
  })

  test("unpacks a gzipped tar, and an empty archive into an empty folder", async () => {
    const tgz = gzipSync(buildTar([{ name: "a/b.txt", data: "in a tar" }]))
    const result = await saveWith(tgz, "bundle.tar.gz")
    expect(readFileSync(join(result.files[0]!.unpacked!, "a", "b.txt"), "utf8")).toBe("in a tar")
    t.close()
    t = createSaveFixture()
    const empty = await saveWith(buildZip([]), "nothing.zip")
    expect(tree(empty.files[0]!.unpacked!)).toEqual([])
  })

  test("is only done when asked for", async () => {
    await saveWith(zip(), "pack.zip", false)
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
  })

  test("a second call with unpack finds the folder and writes nothing", async () => {
    const first = await saveWith(zip())
    const target = first.files[0]!.unpacked!
    writeFileSync(join(target, "mine.txt"), "added by the user")
    const before = tree(t.folder)

    const second = await t.save(saveArgs({ unpack: true }))

    expect(second.files[0]).toMatchObject({ already_saved: true, unpacked: target, already_unpacked: true })
    expect(tree(t.folder)).toEqual(before)
    expect(readFileSync(join(target, "mine.txt"), "utf8")).toBe("added by the user")
  })

  test("a second call with unpack unpacks an archive the first call only saved", async () => {
    await saveWith(zip(), "pack.zip", false)
    const second = await t.save(saveArgs({ unpack: true }))
    expect(second.files[0]).toMatchObject({ already_saved: true, unpacked: join(t.folder, "pack.zip.unpacked") })
    expect(tree(join(t.folder, "pack.zip.unpacked"))).toContain("docs/readme.txt")
  })

  test("a file already named like the folder is not touched: the unpacked folder is numbered", async () => {
    mkdirSync(t.folder, { recursive: true })
    writeFileSync(join(t.folder, "pack.zip.unpacked"), "in the way")
    const result = await saveWith(zip())
    expect(result.files[0]!.unpacked).toBe(join(t.folder, "pack.zip (2).unpacked"))
    expect(readFileSync(join(t.folder, "pack.zip.unpacked"), "utf8")).toBe("in the way")
  })

  test("unpacks each archive of the message, and none of the plain files", async () => {
    t.store("a", zip())
    t.store("b", "plain")
    t.store("c", buildTar([{ name: "x.txt", data: "x" }]))
    t.ingest(
      messageWithFiles(SENT, [
        { id: "a", filename: "one.zip" },
        { id: "b", filename: "two.txt" },
        { id: "c", filename: "three.tar" },
      ]),
    )
    const result = await t.save(saveArgs({ unpack: true }))
    expect(result.files.map((file) => file.unpacked !== undefined)).toEqual([true, false, true])
  })

  test("a hostile archive is refused before it can be unpacked", async () => {
    const result = await saveWith(buildZip([{ name: "../out.txt", data: "x" }]))
    expect(result.files).toEqual([])
    expect(readdirSync(t.folder)).toEqual([])
  })
})

describe("an unpack that fails", () => {
  const boom = () => Promise.reject(new Error("disk is full"))

  test("is listed under errors.unpack:<name> with no detail it cannot vouch for, and the archive stays saved", async () => {
    t.store("arc", zip())
    t.ingest(messageWithFiles(SENT, [{ id: "arc", filename: "pack.zip" }]))
    const result = await t.save(saveArgs({ unpack: true }), { host: { unpack: boom } })
    expect(result.files[0]).toMatchObject({ name: "pack.zip" })
    expect(result.files[0]!.unpacked).toBeUndefined()
    expect(result.errors).toEqual({ "unpack:pack.zip": "failed" })
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
  })

  test("an error that is not ours says only its code, never a path", async () => {
    t.store("arc", zip())
    t.ingest(messageWithFiles(SENT, [{ id: "arc", filename: "pack.zip" }]))
    const enospc = () => Promise.reject(Object.assign(new Error(`ENOSPC at ${t.stateDir}`), { code: "ENOSPC" }))
    const result = await t.save(saveArgs({ unpack: true }), { host: { unpack: enospc } })
    expect(result.errors).toEqual({ "unpack:pack.zip": "failed (ENOSPC)" })
  })

  describe("midway", () => {
    let fixtures: Fixtures
    beforeEach(() => {
      fixtures = createFixtures()
    })
    afterEach(() => fixtures.remove())

    /** Whether a staging folder of unpacking in `folder` has had something written in it. */
    const somethingWritten = (folder: string) =>
      readdirSync(folder).some((name) => name.endsWith(".unpacking") && readdirSync(join(folder, name)).length > 0)

    test("removes the staging folder, the private copy and everything written, leaving only the archive", async () => {
      const folder = fixtures.write("pack.zip", zip()).replace(/pack\.zip$/, "")
      const archivePath = join(folder, "pack.zip")
      // stopped at the first check after a file has been created below the staging folder
      const signal = abortWhen(() => somethingWritten(folder))

      await expect(unpackArchive({ archivePath, name: "pack.zip", folder, signal })).rejects.toMatchObject({
        name: "AbortError",
      })

      expect(readdirSync(folder)).toEqual(["pack.zip"])
    })

    test("stops promptly in the middle of a large entry, between two chunks of its data", async () => {
      const big = buildZip([{ name: "big.bin", data: Buffer.alloc(3_000_000, 0x61), method: "stored" }])
      const folder = fixtures.write("big.zip", big).replace(/big\.zip$/, "")
      let sizeWhenStopped = -1
      const signal = abortWhen(() => {
        const staging = readdirSync(folder).find((name) => name.endsWith(".unpacking"))
        if (staging === undefined || !existsSync(join(folder, staging, "big.bin"))) return false
        sizeWhenStopped = statSync(join(folder, staging, "big.bin")).size
        return sizeWhenStopped > 0
      })
      await expect(
        unpackArchive({ archivePath: join(folder, "big.zip"), name: "big.zip", folder, signal }),
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(sizeWhenStopped).toBeGreaterThan(0)
      expect(sizeWhenStopped).toBeLessThan(3_000_000)
      expect(readdirSync(folder)).toEqual(["big.zip"])
    })

    test("is stopped by the signal while the copy of the archive is inspected", async () => {
      const folder = fixtures.write("pack.zip", zip()).replace(/pack\.zip$/, "")
      let checks = 0
      // the copy takes two checks; the inspection that follows is the next ones, before any staging folder exists
      const signal = abortWhen(() => ++checks > 4 && !readdirSync(folder).some((name) => name.endsWith(".unpacking")))
      await expect(
        unpackArchive({ archivePath: join(folder, "pack.zip"), name: "pack.zip", folder, signal }),
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(readdirSync(folder)).toEqual(["pack.zip"])
    })

    test("does the same when the archive turns out not to be one any more", async () => {
      const folder = fixtures.write("pack.zip", Buffer.from("no longer an archive")).replace(/pack\.zip$/, "")
      await expect(unpackArchive({ archivePath: join(folder, "pack.zip"), name: "pack.zip", folder })).rejects.toThrow()
      expect(readdirSync(folder)).toEqual(["pack.zip"])
    })

    test("unpacks the same archive when nothing stops it", async () => {
      const folder = fixtures.write("pack.zip", zip()).replace(/pack\.zip$/, "")
      const unpacked = await unpackArchive({ archivePath: join(folder, "pack.zip"), name: "pack.zip", folder })
      expect(unpacked.alreadyUnpacked).toBe(false)
      expect(readdirSync(folder).sort()).toEqual(["pack.zip", "pack.zip.unpacked"])
    })
  })

  describe("publishing the unpacked folder", () => {
    let fixtures: Fixtures
    beforeEach(() => {
      fixtures = createFixtures()
    })
    afterEach(() => fixtures.remove())

    test("never replaces what has been put in the folder meanwhile: the next name is taken", async () => {
      const folder = fixtures.write("pack.zip", zip()).replace(/pack\.zip$/, "")
      const targets: string[] = []
      const beforeRename = (target: string) => {
        targets.push(target)
        // someone fills the folder that was just made, after it was made and before the rename
        if (targets.length === 1) writeFileSync(join(target, "theirs.txt"), "not ours")
      }

      const unpacked = await unpackArchive({
        archivePath: join(folder, "pack.zip"),
        name: "pack.zip",
        folder,
        beforeRename,
      })

      expect(targets.map((target) => target.replace(folder, ""))).toEqual([
        "pack.zip.unpacked",
        "pack.zip (2).unpacked",
      ])
      expect(unpacked.path).toBe(join(folder, "pack.zip (2).unpacked"))
      expect(readdirSync(join(folder, "pack.zip.unpacked"))).toEqual(["theirs.txt"])
      expect(readFileSync(join(folder, "pack.zip.unpacked", "theirs.txt"), "utf8")).toBe("not ours")
      expect(tree(unpacked.path)).toContain("docs/readme.txt")
      expect(readdirSync(folder).filter((name) => name.startsWith("."))).toEqual([])
    })

    test("removes the folder it made again when it is still empty and the rename fails", async () => {
      const folder = fixtures.write("pack.zip", zip()).replace(/pack\.zip$/, "")
      const boom = new Error("rename would have failed")
      await expect(
        unpackArchive({
          archivePath: join(folder, "pack.zip"),
          name: "pack.zip",
          folder,
          beforeRename: () => {
            throw boom
          },
        }),
      ).rejects.toBe(boom)
      expect(readdirSync(folder)).toEqual(["pack.zip"])
    })

    test("makes the folder itself, so a name that is taken in any form is never replaced", async () => {
      const folder = fixtures.write("pack.zip", zip()).replace(/pack\.zip$/, "")
      writeFileSync(join(folder, "pack.zip.unpacked"), "a file")
      symlinkSync(join(folder, "elsewhere"), join(folder, "pack.zip (2).unpacked"))
      const unpacked = await unpackArchive({ archivePath: join(folder, "pack.zip"), name: "pack.zip", folder })
      expect(unpacked.path).toBe(join(folder, "pack.zip (3).unpacked"))
      expect(readFileSync(join(folder, "pack.zip.unpacked"), "utf8")).toBe("a file")
    })
  })
})
