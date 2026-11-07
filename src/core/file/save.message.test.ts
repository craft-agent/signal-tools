import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { PRIVATE_NOTE } from "../chat/message-schema"
import { ALICE, ME, deleteFrom, sentTo } from "../signal/mirror.testing"
import { MESSAGE_ID, SENT, createSaveFixture, messageWithFiles, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
  t.store("att", "data")
})
afterEach(() => t.close())

const withFile = (sent = SENT, extra: Record<string, unknown> = {}) =>
  messageWithFiles(sent, [{ id: "att", filename: "f.txt" }], extra)

describe("which message is asked for", () => {
  test("an id the mirror does not know is not_found, and nothing is made", async () => {
    t.ingest(withFile())
    const error = await t.failure(saveArgs({ id: `${ALICE}:${SENT + 5}` }))
    expect(error).toMatchObject({ code: "not_found", message: "No message with this id in this chat." })
    expect(existsSync(join(t.downloadDir, "default"))).toBe(false)
  })

  test("a message of another chat is not found in this one", async () => {
    t.ingest(withFile())
    const error = await t.failure(saveArgs({ chat: ME }))
    expect(error.code).toBe("not_found")
  })

  test("a chat the mirror does not have is not_found", async () => {
    expect((await t.failure(saveArgs({ chat: "55555555-5555-4555-8555-555555555555" }))).code).toBe("not_found")
  })

  test("a message id that is not one, and a chat that is not an id, are invalid_argument", async () => {
    t.ingest(withFile())
    expect((await t.failure(saveArgs({ id: "not-an-id" }))).code).toBe("invalid_argument")
    expect((await t.failure(saveArgs({ id: `${ALICE}:0` }))).code).toBe("invalid_argument")
    expect((await t.failure(saveArgs({ chat: "Alice" }))).code).toBe("invalid_argument")
  })

  test("an unknown argument is invalid_argument", async () => {
    t.ingest(withFile())
    expect((await t.failure(saveArgs({ path: "/etc" }))).code).toBe("invalid_argument")
  })

  test("a message deleted for everyone is gone", async () => {
    t.ingest(withFile(), deleteFrom(ALICE, SENT))
    const error = await t.failure(saveArgs())
    expect(error).toMatchObject({
      code: "not_found",
      message: "That message is gone; it was deleted or has disappeared.",
    })
  })

  test("a message whose time has run out is gone", async () => {
    t.ingest(
      sentTo(ALICE, SENT, { message: "x", expiresInSeconds: 60, attachments: [{ id: "att", filename: "f.txt" }] }),
    )
    expect((await t.failure(saveArgs({ id: `${ME}:${SENT}` }))).message).toContain("gone")
  })

  test("a message with no files, and a timer change, are not_found", async () => {
    t.ingest(
      messageWithFiles(SENT + 1, []),
      sentTo(ALICE, SENT + 2, { isExpirationUpdate: true, expiresInSeconds: 30 }),
    )
    const none = await t.failure(saveArgs({ id: `${ALICE}:${SENT + 1}` }))
    expect(none).toMatchObject({ code: "not_found", message: "That message has no files." })
    const timer = await t.failure(saveArgs({ id: `${ME}:${SENT + 2}`, chat: ALICE }))
    expect(timer).toMatchObject({ code: "not_found", message: "That message has no files." })
  })

  test("a view-once message's files are forbidden and never saved", async () => {
    t.ingest(withFile(SENT, { viewOnce: true }))
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe("A view-once message's files are not saved: its sender meant them to be seen once.")
    expect(existsSync(join(t.downloadDir, "default"))).toBe(false)
  })

  test("a disappearing message's files are saved, with the private note", async () => {
    t.ingest(withFile(SENT, { expiresInSeconds: 3600 }))
    const result = await t.save(saveArgs())
    expect(result.files.map((file) => file.name)).toEqual(["f.txt"])
    expect(result.private_note).toBe(PRIVATE_NOTE)
  })

  test("an ordinary message has no private note", async () => {
    t.ingest(withFile())
    expect((await t.save(saveArgs())).private_note).toBeUndefined()
  })

  test("the account argument picks the label, and an unknown one is not_found-like", async () => {
    t.ingest(withFile())
    expect((await t.save(saveArgs({ account: "default" }))).chat).toBe(ALICE)
    expect((await t.failure(saveArgs({ account: "nobody" }))).code).not.toBe("internal_error")
  })

  test("the result names the chat and the message as given", async () => {
    t.ingest(withFile())
    const result = await t.save(saveArgs())
    expect(result).toMatchObject({ chat: ALICE, id: MESSAGE_ID })
  })
})
