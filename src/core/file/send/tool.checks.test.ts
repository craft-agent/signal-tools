import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ELF_BYTES } from "../../archive/archive.testing"
import { buildZip } from "../../archive/zip.testing"
import { accepted } from "../../message/send.testing"
import { fakeKey } from "../../outgoing/outgoing.testing"
import { ALICE } from "../../signal/mirror.testing"
import { createFileSend } from "./tool"
import { canMakeFifo, createFileSendFixture, makeFifo, type FileSendFixture } from "./tool.testing"

let t: FileSendFixture

beforeEach(async () => {
  t = createFileSendFixture()
  await t.serve(accepted(ALICE))
})

afterEach(async () => {
  await t.close()
})

/** Calls the tool with the files, which must fail with `code` before anything is sent or left behind. */
async function refused(
  files: Array<{ path: string; sha256?: string }>,
  code: string,
  extra: Record<string, unknown> = {},
) {
  const error = await t.filesFailure({ chat: ALICE, files, ...extra })
  expect(error).toMatchObject({ code })
  expect(t.sends()).toBe(0)
  expect(t.outboxEntries()).toEqual([])
  return error
}

describe("sha256", () => {
  const sha = (content: string) => createHash("sha256").update(content).digest("hex")

  test("a file that matches is sent, whatever case the digest is written in", async () => {
    const path = t.write("a.txt", "approved\n")
    await t.sendFiles({ chat: ALICE, files: [{ path, sha256: sha("approved\n") }] })
    await t.sendFiles({ chat: ALICE, files: [{ path, sha256: sha("approved\n").toUpperCase() }] })
    expect(t.sends()).toBe(2)
  })

  test("a file that differs is stale, naming the path as given, and nothing is sent", async () => {
    t.write("a.txt", "changed since\n")
    const error = await refused([{ path: "a.txt", sha256: sha("approved\n") }], "stale")
    expect(error.message).toBe('"a.txt" is not the file that was approved: its SHA-256 differs.')
  })

  test("a digest that is not 64 hexadecimal digits is invalid_argument", async () => {
    const path = t.write("a.txt")
    for (const sha256 of ["abc", "g".repeat(64), `${"a".repeat(63)}`]) {
      await refused([{ path, sha256 }], "invalid_argument")
    }
  })

  test("one file that differs among several stops the whole send", async () => {
    await refused([{ path: t.write("a.txt") }, { path: t.write("b.txt"), sha256: "f".repeat(64) }], "stale")
  })
})

describe("files that are refused before anything is sent", () => {
  test("a path outside the working directory, saying how to allow it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "send-outside-"))
    const path = join(outside, "plain.txt")
    writeFileSync(path, "x")
    const error = await refused([{ path }], "forbidden")
    expect(error.message).toContain("send_dirs")
  })

  test("a path outside through a link, and one that climbs out with ..", async () => {
    const outside = mkdtempSync(join(tmpdir(), "send-outside-"))
    writeFileSync(join(outside, "plain.txt"), "x")
    symlinkSync(join(outside, "plain.txt"), join(t.work, "link.txt"))
    await refused([{ path: "link.txt" }], "forbidden")
    await refused([{ path: `../${outside.split("/").pop()}/plain.txt` }], "forbidden")
  })

  test("a path in a send directory is sent once the context names it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "send-outside-"))
    const path = join(outside, "plain.txt")
    writeFileSync(path, "x")
    const result = await t.sendFiles({ chat: ALICE, files: [{ path }] }, { sendDirs: [outside] })
    expect(result.files[0]!.path).toBe(join(realpathSync(outside), "plain.txt"))
  })

  test("a file that does not exist", async () => {
    await refused([{ path: "missing.txt" }], "not_found")
  })

  test("a name that looks like a key or a secret, and a key folder", async () => {
    await refused([{ path: t.write(".env", "A=1\n") }], "forbidden")
    await refused([{ path: t.write("keys/server.pem", "x") }], "forbidden")
    await refused([{ path: t.write(".ssh/config", "x") }], "forbidden")
  })

  test("a private key inside a file with an innocent name, naming the file as given", async () => {
    t.write("notes.txt", `before\n${fakeKey("RSA ")}`)
    const error = await refused([{ path: "notes.txt" }], "forbidden")
    expect(error.message).toBe('"notes.txt" cannot be sent: it is a private key.')
  })

  test("a program under an innocent name", async () => {
    t.write("notes.txt", ELF_BYTES)
    const error = await refused([{ path: "notes.txt" }], "forbidden")
    expect(error.message).toBe('"notes.txt" cannot be sent: it is a program.')
  })

  test("an empty file", async () => {
    t.write("empty.txt", "")
    const error = await refused([{ path: "empty.txt" }], "forbidden")
    expect(error.message).toContain("it is an empty file")
  })

  test("an archive with an entry that may not leave, naming the entry", async () => {
    t.write(
      "bundle.zip",
      buildZip([
        { name: "ok.txt", data: "fine" },
        { name: "app/.env", data: "A=1\n" },
      ]),
    )
    const error = await refused([{ path: "bundle.zip" }], "forbidden")
    expect(error.message).toBe('"bundle.zip" cannot be sent: the entry app/.env is named like a key or a secret.')
  })

  test("a hard link, whose other name could be anywhere", async () => {
    const hidden = t.write(".ssh/notes.txt")
    linkSync(hidden, join(t.work, "innocent.txt"))
    await refused([{ path: "innocent.txt" }], "forbidden")
  })

  test("the same file twice, by the same path or by a link to it, naming the second path as given", async () => {
    const path = t.write("a.txt")
    symlinkSync(path, join(t.work, "again.txt"))
    const error = await refused([{ path }, { path: "again.txt" }], "invalid_argument")
    expect(error.message).toContain('"again.txt"')
    await refused([{ path: "a.txt" }, { path: "./a.txt" }], "invalid_argument")
  })

  test("a file in the state directory, though the working directory is above it", async () => {
    const error = await t.filesFailure(
      { chat: ALICE, files: [{ path: join(t.paths.dir, "mirror.sqlite") }] },
      { cwd: t.stateDir, sendDirs: [t.stateDir] },
    )
    expect(error).toMatchObject({ code: "forbidden" })
    expect(error.message).not.toContain("send_dirs")
    expect(t.sends()).toBe(0)
  })

  test("a file in the tools' own directory", async () => {
    const own = mkdtempSync(join(tmpdir(), "send-own-"))
    writeFileSync(join(own, "plain.txt"), "x")
    const error = await t.filesFailure(
      { chat: ALICE, files: [{ path: join(own, "plain.txt") }] },
      { sendDirs: [own], ownDir: own },
    )
    expect(error).toMatchObject({ code: "forbidden" })
  })

  test.skipIf(!canMakeFifo())("a FIFO is not a file, and the call does not wait for a writer", async () => {
    makeFifo(join(t.work, "pipe"))
    const started = Date.now()
    await refused([{ path: "pipe" }], "invalid_argument")
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("a folder is not a file", async () => {
    mkdirSync(join(t.work, "folder"))
    await refused([{ path: "folder" }], "invalid_argument")
  })

  test("a refused file among good ones stops all of them", async () => {
    await refused([{ path: t.write("a.txt") }, { path: t.write(".env") }, { path: t.write("c.txt") }], "forbidden")
  })
})

describe("what a send takes", () => {
  test("more than 10 files, or none, is invalid_argument", async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ path: t.write(`f${i}.txt`) }))
    await refused(files, "invalid_argument")
    await refused([], "invalid_argument")
    expect(await t.sendFiles({ chat: ALICE, files: files.slice(0, 10) })).toMatchObject({ chat: ALICE })
  })

  test("more bytes than the limit is invalid_argument, counted over all the files, and nothing is sent", async () => {
    const small = createFileSend({ maxTotalBytes: 100 })
    const files = [{ path: t.write("a.txt", "x".repeat(60)) }, { path: t.write("b.txt", "y".repeat(60)) }]
    const error = await t.filesFailure({ chat: ALICE, files }, {}, small)
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(error.message).toContain("100 bytes")
    expect(t.sends()).toBe(0)
    expect(t.outboxEntries()).toEqual([])
    expect(await t.sendFiles({ chat: ALICE, files: files.slice(0, 1) }, {}, small)).toMatchObject({ chat: ALICE })
  })

  test("a caption over 4,000 characters is refused before anything is copied", async () => {
    const path = t.write("a.txt")
    await refused([{ path }], "invalid_argument", { text: "x".repeat(4001) })
  })
})
