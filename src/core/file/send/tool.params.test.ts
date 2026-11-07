import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { basename } from "node:path"
import { GROUP } from "../../chat/read.testing"
import { accepted, SENT } from "../../message/send.testing"
import { messageId } from "../../signal/ids"
import { ALICE, GROUP_ID, ME } from "../../signal/mirror.testing"
import { formatLocalTime } from "../../time"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
})

afterEach(async () => {
  await t.close()
})

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex")

describe("what signal-cli is given", () => {
  test("a file to a person, with a caption: the copy's path, the caption and the person", async () => {
    const path = t.write("notes/today.txt", "hello\n")
    const seen = await t.serveAndSee(accepted(ALICE))
    const result = await t.sendFiles({ chat: ALICE, files: [{ path }], text: "  here you go \n" })
    expect(result).toEqual({
      id: `${ME}:${SENT}`,
      chat: ALICE,
      time: formatLocalTime(SENT),
      files: [{ path, name: "today.txt", size: 6, sha256: sha256("hello\n") }],
    })
    expect(t.sentParams()).toEqual({ recipient: [ALICE], message: "here you go", attachment: [seen[0]!.path] })
  })

  test("the attachment is a private copy in the outbox, named as the file is, with the file's bytes", async () => {
    const path = t.write("report.pdf", "%PDF made up\n")
    const seen = await t.serveAndSee(accepted(ALICE))
    await t.sendFiles({ chat: ALICE, files: [{ path }] })
    const [copy] = seen
    expect(copy!.path.startsWith(`${t.paths.outbox}/`)).toBe(true)
    expect(basename(copy!.path)).toBe("report.pdf")
    expect(copy!.path).not.toBe(path)
    expect(copy!.content.toString()).toBe("%PDF made up\n")
    expect(copy!.mode).toBe(0o600)
    expect(copy!.folderMode).toBe(0o700)
  })

  test("without a caption no message is sent, only the files; a blank caption is none", async () => {
    const path = t.write("a.txt")
    await t.serve(accepted(ALICE))
    await t.sendFiles({ chat: ALICE, files: [{ path }] })
    await t.sendFiles({ chat: ALICE, files: [{ path }], text: " \n " })
    const sends = t.daemon().calls.filter((call) => call.method === "send")
    expect(sends).toHaveLength(2)
    for (const { params } of sends) expect(params).not.toHaveProperty("message")
  })

  test("several files go as one send, in the order given, each in a folder of its own", async () => {
    const first = t.write("one/a.txt", "1")
    const second = t.write("two/a.txt", "22")
    const seen = await t.serveAndSee(accepted(ALICE))
    const result = await t.sendFiles({ chat: ALICE, files: [{ path: first }, { path: second }] })
    expect(result.files.map((file) => [file.name, file.size])).toEqual([
      ["a.txt", 1],
      ["a.txt", 2],
    ])
    expect(seen.map((copy) => copy.content.toString())).toEqual(["1", "22"])
    expect(new Set(seen.map((copy) => copy.path)).size).toBe(2)
    expect(t.sentParams()).toMatchObject({ attachment: seen.map((copy) => copy.path) })
  })

  test("a relative path is read against the working directory and reported by its real path", async () => {
    const path = t.write("sub/data.csv", "a,b\n")
    await t.serve(accepted(ALICE))
    const result = await t.sendFiles({ chat: ALICE, files: [{ path: "sub/../sub/data.csv" }] })
    expect(result.files[0]!.path).toBe(path)
  })

  test("a group is sent to by its id without the prefix and reports how many members it reached", async () => {
    await t.serve(accepted(ALICE, "33333333-3333-4333-8333-333333333333"))
    const result = await t.sendFiles({ chat: GROUP, files: [{ path: t.write("a.txt") }], text: "team" })
    expect(result.reached).toBe(2)
    expect(t.sentParams()).toMatchObject({ groupId: GROUP_ID, message: "team" })
    expect(t.sentParams()).not.toHaveProperty("recipient")
  })

  test("Note to Self goes with the flag", async () => {
    await t.serve({ result: { timestamp: SENT } })
    const result = await t.sendFiles({ chat: ME, files: [{ path: t.write("a.txt") }] })
    expect(result.id).toBe(`${ME}:${SENT}`)
    expect(t.sentParams()).toMatchObject({ noteToSelf: true })
  })

  test("a reply quotes the message by the quote parameters of a text", async () => {
    await t.serve(accepted(ALICE))
    await t.sendFiles({
      chat: ALICE,
      files: [{ path: t.write("a.txt") }],
      text: "the file",
      reply_to: messageId(ALICE, 5000),
    })
    expect(t.sentParams()).toMatchObject({
      message: "the file",
      quoteTimestamp: 5000,
      quoteAuthor: ALICE,
      quoteMessage: "hello from Alice",
    })
  })

  test("the upload is given five minutes, not a minute", async () => {
    await t.serve(accepted(ALICE))
    const timers: number[] = []
    const original = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") timers.push(ms)
      return original(handler, ms, ...rest)
    }) as typeof setTimeout
    try {
      await t.sendFiles({ chat: ALICE, files: [{ path: t.write("a.txt") }] })
    } finally {
      globalThis.setTimeout = original
    }
    expect(timers).toContain(300_000)
  })
})
