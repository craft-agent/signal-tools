import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { messageId } from "../signal/ids"
import { labelPaths } from "../signal/labels"
import { ALICE, ME } from "../signal/mirror.testing"
import { writeTargets } from "../targets"
import { annotations, toolMeta, REQUIRES_USER_INTERACTION } from "../tool"
import { createActionFixture, OWN, type ActionFixture } from "./action.testing"
import { signalMessageDelete } from "./delete"
import { signalMessageEdit } from "./edit"
import { signalMessageReact } from "./react"

const ID = messageId(ME, OWN)

let t: ActionFixture

beforeEach(() => {
  t = createActionFixture()
})

afterEach(async () => {
  await t.close()
})

describe.each([
  ["signal_message_edit", signalMessageEdit, { text: "x" }],
  ["signal_message_delete", signalMessageDelete, {}],
  ["signal_message_react", signalMessageReact, { emoji: "👍" }],
] as const)("the targets of %s", (_id, tool, extra) => {
  const targets = (args: Record<string, unknown>, stateDir = t.stateDir) =>
    writeTargets(tool, { ...extra, ...args }, { cwd: stateDir, stateDir })

  test("name the label, the chat and the message", async () => {
    expect(await targets({ chat: ALICE, id: ID })).toEqual([`default/${ALICE}/${ID}`])
    expect(await targets({ account: "default", chat: "group:abc", id: ID })).toEqual([`default/group:abc/${ID}`])
  })

  test("are any when the label cannot be resolved", async () => {
    expect(await targets({ account: "nobody", chat: ALICE, id: ID })).toEqual(["*"])
    mkdirSync(labelPaths(t.stateDir, "second").dir)
    expect(await targets({ chat: ALICE, id: ID })).toEqual(["*"])
  })

  test("are any without a state directory", async () => {
    expect(await writeTargets(tool, { ...extra, chat: ALICE, id: ID }, { cwd: t.stateDir })).toEqual(["*"])
  })

  test("are any when the chat or the id holds a wildcard", async () => {
    expect(await targets({ chat: "group:*", id: ID })).toEqual(["*"])
    expect(await targets({ chat: ALICE, id: "a?b" })).toEqual(["*"])
  })

  test("are any for arguments the schema refuses", async () => {
    expect(await targets({ chat: ALICE })).toEqual(["*"])
  })
})

describe("the write classes", () => {
  test("the reaction overwrites, in the actions toolset, as it replaces the user's earlier one", () => {
    expect(signalMessageReact).toMatchObject({ id: "signal_message_react", toolset: "actions", class: "overwrite" })
    expect(annotations(signalMessageReact)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })
    expect(toolMeta(signalMessageReact)).toBeUndefined()
  })

  test("the edit overwrites, in the actions toolset", () => {
    expect(signalMessageEdit).toMatchObject({ id: "signal_message_edit", toolset: "actions", class: "overwrite" })
    expect(annotations(signalMessageEdit)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })
    expect(toolMeta(signalMessageEdit)).toBeUndefined()
  })

  test("the delete is administrative, in the actions toolset, and asks even under an allow rule", () => {
    expect(signalMessageDelete).toMatchObject({
      id: "signal_message_delete",
      toolset: "actions",
      class: "administrative",
    })
    expect(annotations(signalMessageDelete)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
    expect(toolMeta(signalMessageDelete)).toEqual({ [REQUIRES_USER_INTERACTION]: true })
  })
})
