import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { join } from "node:path"
import { accepted } from "../../message/send.testing"
import { ALICE } from "../../signal/mirror.testing"
import { writeTargets } from "../../targets"
import { annotations } from "../../tool"
import { contentTypeOf, UNKNOWN_CONTENT_TYPE } from "./content-types"
import { signalFileSend } from "./tool"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
})

afterEach(async () => {
  await t.close()
})

test("the tool is an add in the files toolset, and so off by default", () => {
  expect(signalFileSend).toMatchObject({ id: "signal_file_send", toolset: "files", class: "add" })
  expect(annotations(signalFileSend)).toMatchObject({ readOnlyHint: false, destructiveHint: false })
})

describe("the arguments", () => {
  test.each([
    ["an unknown argument", { extra: 1 }],
    ["an unknown key of a file", { files: [{ path: "a.txt", name: "b" }] }],
    ["a file without a path", { files: [{}] }],
    ["an empty path", { files: [{ path: "" }] }],
    ["files as text", { files: "a.txt" }],
    ["a caption that is not text", { text: 5 }],
  ])("%s is invalid_argument", async (_what, extra) => {
    await t.serve(accepted(ALICE))
    const error = await t.filesFailure({ chat: ALICE, files: [{ path: t.write("a.txt") }], ...extra })
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(t.sends()).toBe(0)
  })

  test("a reply to something that is not a message id is invalid_argument, before any file is read", async () => {
    await t.serve(accepted(ALICE))
    const error = await t.filesFailure({ chat: ALICE, files: [{ path: "missing.txt" }], reply_to: "nope" })
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(error.message).toContain("reply_to")
  })

  test("a chat the mirror does not have is refused before any file is read", async () => {
    await t.serve(accepted(ALICE))
    expect(
      await t.filesFailure({ chat: "44444444-4444-4444-8444-444444444444", files: [{ path: "missing.txt" }] }),
    ).toMatchObject({
      code: "not_found",
    })
  })

  test("an unknown account is not_found", async () => {
    expect(await t.filesFailure({ account: "other", chat: ALICE, files: [{ path: t.write("a.txt") }] })).toMatchObject({
      code: "not_found",
    })
  })
})

describe("the result", () => {
  test("names no outbox or state path, however the call ends", async () => {
    await t.serve(accepted(ALICE))
    const result = await t.sendFiles({ chat: ALICE, files: [{ path: t.write("a.txt") }] })
    expect(JSON.stringify(result)).not.toContain(t.stateDir)
    const error = await t.filesFailure({ chat: ALICE, files: [{ path: t.write("b.pem") }] })
    expect(error.message).not.toContain(t.stateDir)
  })
})

describe("targets", () => {
  const targets = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
    writeTargets(signalFileSend, args, { cwd: t.work, stateDir: t.stateDir, ...ctx })

  test("name the chat with its label and each file by real path", async () => {
    const real = t.write("real/a.txt")
    symlinkSync(real, join(t.work, "alias.txt"))
    expect(await targets({ chat: ALICE, files: [{ path: "alias.txt" }, { path: real }] })).toEqual(
      [`default/${ALICE}`, real].sort(),
    )
  })

  test("name a file that does not resolve by its path made absolute against the working directory", async () => {
    expect(await targets({ chat: ALICE, files: [{ path: "sub/../missing.txt" }] })).toEqual(
      [`default/${ALICE}`, join(t.work, "missing.txt")].sort(),
    )
  })

  test("are any for the chat when the label cannot be told, and still name the files", async () => {
    const path = t.write("a.txt")
    expect(await targets({ account: "nobody", chat: ALICE, files: [{ path }] })).toEqual([path, "*"])
    expect(await targets({ chat: ALICE, files: [{ path }] }, { stateDir: undefined })).toEqual([path, "*"])
  })

  test("are any for a file name that holds a wildcard", async () => {
    expect(await targets({ chat: ALICE, files: [{ path: "dir/*.txt" }] })).toEqual([`default/${ALICE}`, "*"])
  })

  test("are any for arguments the schema refuses", async () => {
    expect(await targets({ chat: ALICE, files: [] })).toEqual(["*"])
  })

  test("write nothing: no outbox is made", async () => {
    await targets({ chat: ALICE, files: [{ path: t.write("a.txt") }] })
    expect(t.outboxEntries()).toEqual([])
  })
})

describe("contentTypeOf", () => {
  test("is read from the extension, in any case", () => {
    expect(contentTypeOf("photo.JPG")).toBe("image/jpeg")
    expect(contentTypeOf("dir/report.pdf")).toBe("application/pdf")
    expect(contentTypeOf("notes.txt.")).toBe("text/plain")
  })

  test("is bytes for what it does not know, and for no extension", () => {
    expect(contentTypeOf("data.xyz")).toBe(UNKNOWN_CONTENT_TYPE)
    expect(contentTypeOf("Makefile")).toBe(UNKNOWN_CONTENT_TYPE)
  })
})
