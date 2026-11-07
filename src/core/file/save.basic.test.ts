import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ALICE } from "../signal/mirror.testing"
import { MESSAGE_ID, SENT, createSaveFixture, messageWithFiles, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex")
const mode = (path: string) => statSync(path).mode & 0o777

describe("saving a message's files", () => {
  test("saves a plain file, private and not executable, with its content and SHA-256", async () => {
    t.store("att-1", "hello, files")
    t.ingest(messageWithFiles(SENT, [{ id: "att-1", contentType: "text/plain", filename: "notes.txt" }]))

    const result = await t.save(saveArgs())

    const path = join(t.folder, "notes.txt")
    expect(result.folder).toBe(t.folder)
    expect(result.files).toEqual([
      { name: "notes.txt", path, type: "text/plain", size: 12, sha256: sha256("hello, files") },
    ])
    expect(result.note).toContain("never executable")
    expect(result.private_note).toBeUndefined()
    expect(readFileSync(path, "utf8")).toBe("hello, files")
    expect(mode(path)).toBe(0o600)
    for (const folder of [t.downloadDir, join(t.downloadDir, "default"), t.folder]) {
      expect(statSync(folder).isDirectory()).toBe(true)
    }
    expect(mode(t.folder)).toBe(0o700)
    expect(mode(join(t.downloadDir, "default"))).toBe(0o700)
    expect(readdirSync(t.folder)).toEqual(["notes.txt"])
  })

  test("makes a download directory that does not exist yet, folder by folder, all private", async () => {
    t.store("att-1", "x")
    t.ingest(messageWithFiles(SENT, [{ id: "att-1", filename: "x.txt" }]))
    const downloadDir = join(t.downloadDir, "new", "deeper")

    const result = await t.save(saveArgs(), { ctx: { downloadDir } })

    expect(result.folder).toBe(join(downloadDir, "default", `${SENT}-${ALICE}`))
    expect(mode(join(t.downloadDir, "new"))).toBe(0o700)
    expect(mode(downloadDir)).toBe(0o700)
  })

  test("saves every file of a message, in order, and keeps the declared type", async () => {
    t.store("a", Buffer.from([1, 2, 3]))
    t.store("b", "second")
    t.ingest(
      messageWithFiles(SENT, [
        { id: "a", contentType: "image/png", filename: "one.png" },
        { id: "b", contentType: "text/plain", filename: "two.txt" },
      ]),
    )
    const result = await t.save(saveArgs())
    expect(result.files.map((file) => [file.name, file.type, file.size])).toEqual([
      ["one.png", "image/png", 3],
      ["two.txt", "text/plain", 6],
    ])
  })

  test("leaves no partial file behind, and never puts an attachment id in the result", async () => {
    t.store("secret-attachment-id", "data")
    t.ingest(messageWithFiles(SENT, [{ id: "secret-attachment-id", filename: "d.txt" }]))
    const result = await t.save(saveArgs())
    expect(readdirSync(t.folder).filter((name) => name.startsWith("."))).toEqual([])
    const json = JSON.stringify(result)
    expect(json).not.toContain("secret-attachment-id")
    expect(json).not.toContain(t.stateDir)
  })

  test("calling it again reuses the file that is saved", async () => {
    t.store("att-1", "same bytes")
    t.ingest(messageWithFiles(SENT, [{ id: "att-1", filename: "same.txt" }]))
    const first = await t.save(saveArgs())
    const second = await t.save(saveArgs())
    expect(first.files[0]!.already_saved).toBeUndefined()
    expect(second.files).toEqual([{ ...first.files[0]!, already_saved: true }])
    expect(readdirSync(t.folder)).toEqual(["same.txt"])
  })

  test("a different file already under the name is never overwritten: the new one is numbered", async () => {
    t.store("att-1", "from the sender")
    t.ingest(messageWithFiles(SENT, [{ id: "att-1", filename: "report.txt" }]))
    mkdirFolder()
    writeFileSync(join(t.folder, "report.txt"), "the user's own", { mode: 0o644 })

    const result = await t.save(saveArgs())

    expect(result.files[0]!.name).toBe("report (2).txt")
    expect(readFileSync(join(t.folder, "report.txt"), "utf8")).toBe("the user's own")
    expect(mode(join(t.folder, "report.txt"))).toBe(0o644)
    expect(readFileSync(join(t.folder, "report (2).txt"), "utf8")).toBe("from the sender")
    const again = await t.save(saveArgs())
    expect(again.files[0]).toMatchObject({ name: "report (2).txt", already_saved: true })
  })

  test.each([0o755, 0o644, 0o666, 0o700, 0o400])(
    "the same bytes at mode %o are not a file this tool made: left untouched, a fresh 0600 copy is numbered",
    async (existingMode) => {
      t.store("att-1", "identical bytes")
      t.ingest(messageWithFiles(SENT, [{ id: "att-1", filename: "same.txt" }]))
      mkdirFolder()
      const existing = join(t.folder, "same.txt")
      writeFileSync(existing, "identical bytes")
      chmodSync(existing, existingMode)

      const result = await t.save(saveArgs())

      expect(result.files[0]).toMatchObject({ name: "same (2).txt" })
      expect(result.files[0]!.already_saved).toBeUndefined()
      expect(mode(existing)).toBe(existingMode)
      expect(readFileSync(existing, "utf8")).toBe("identical bytes")
      expect(mode(join(t.folder, "same (2).txt"))).toBe(0o600)
      const again = await t.save(saveArgs())
      expect(again.files[0]).toMatchObject({ name: "same (2).txt", already_saved: true })
      expect(mode(existing)).toBe(existingMode)
    },
  )

  test("a file with the same bytes that is exactly what the tool makes is reused", async () => {
    t.store("att-1", "identical bytes")
    t.ingest(messageWithFiles(SENT, [{ id: "att-1", filename: "same.txt" }]))
    mkdirFolder()
    writeFileSync(join(t.folder, "same.txt"), "identical bytes", { mode: 0o600 })
    chmodSync(join(t.folder, "same.txt"), 0o600)
    expect((await t.save(saveArgs())).files[0]).toMatchObject({ name: "same.txt", already_saved: true })
  })

  test("a file that is the same size but not the same bytes is not taken for the saved one", async () => {
    t.store("att-1", "aaaa")
    t.ingest(messageWithFiles(SENT, [{ id: "att-1", filename: "x.bin" }]))
    mkdirFolder()
    writeFileSync(join(t.folder, "x.bin"), "bbbb")
    expect((await t.save(saveArgs())).files[0]!.name).toBe("x (2).bin")
  })

  test("saves into the folder of another message separately", async () => {
    t.store("a", "one")
    t.store("b", "two")
    t.ingest(
      messageWithFiles(SENT, [{ id: "a", filename: "f.txt" }]),
      messageWithFiles(SENT + 1, [{ id: "b", filename: "f.txt" }]),
    )
    const first = await t.save(saveArgs())
    const second = await t.save(saveArgs({ id: `${ALICE}:${SENT + 1}` }))
    expect(first.folder).not.toBe(second.folder)
    expect(readFileSync(join(second.folder, "f.txt"), "utf8")).toBe("two")
    expect(MESSAGE_ID).toContain(String(SENT))
  })
})

/** Makes the message's folder, as an earlier call or the user would have. */
function mkdirFolder(): void {
  mkdirSync(t.folder, { recursive: true, mode: 0o700 })
}
