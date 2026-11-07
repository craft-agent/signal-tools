import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { labelPaths } from "../signal/labels"
import { ALICE, dataFrom, makeTempDir } from "../signal/mirror.testing"
import { invoke } from "../tool"
import { signalChatRead } from "./read"
import { createChatFixture, type ChatFixture } from "./read.testing"

describe("chat read: accounts", () => {
  let t: ChatFixture

  beforeEach(() => {
    t = createChatFixture()
    t.ingest(dataFrom(ALICE, 1000, { message: "hi" }))
  })

  afterEach(() => {
    t.close()
  })

  test("account names the label whose mirror is read", async () => {
    expect((await t.read({ method: "list", account: "default" })).chats).toHaveLength(1)
    expect((await t.failure({ method: "list", account: "Bad/Label" })).code).toBe("invalid_argument")
    expect((await t.failure({ method: "list", account: "other" })).code).toBe("not_found")
  })

  test("no account, a label without a mirror and a missing state directory are refused", async () => {
    const stateDir = makeTempDir()
    try {
      const call = (args: unknown) => invoke(signalChatRead, args, { cwd: stateDir, stateDir })
      await expect(call({ method: "list" })).rejects.toMatchObject({ code: "not_found" })
      mkdirSync(labelPaths(stateDir, "default").dir)
      await expect(call({ method: "list" })).rejects.toMatchObject({ code: "not_found" })
      await expect(invoke(signalChatRead, { method: "list" }, { cwd: stateDir })).rejects.toMatchObject({
        code: "internal_error",
      })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
