import { describe, expect, test } from "bun:test"
import { gateRefusal } from "../entry/gate"
import { ALL_TOOLS } from "../tools"
import { existingChat } from "./chat/chat-rows"
import { signalChatRead } from "./chat/read"
import { createTestMirror } from "./signal/mirror.testing"
import { invoke, type ToolContext } from "./tool"

const EXCLUDED = "1a2b3c4d-2222-4333-8444-5555555555ab"
const EXCLUDED_GROUP = `group:${"G".repeat(43)}`
const OTHER = "6e6f6a6b-7777-4888-9999-0000000000cd"
const MESSAGE = `${EXCLUDED}:1000`
const UNKNOWN = { code: "not_found", message: "No chat with this id in this account's mirror." }

const ctx: ToolContext = {
  cwd: "/unavailable",
  options: { exclude_chats: [EXCLUDED, EXCLUDED_GROUP] },
  get stateDir(): string {
    throw new Error("The gate must not open the mirror or contact the service")
  },
}

/** `ctx` with another `exclude_chats` value, keeping the state directory that throws. */
function withSetting(chats: string[]): ToolContext {
  return Object.assign(Object.create(ctx), { options: { exclude_chats: chats } })
}

/** Valid arguments of each tool that names a chat, besides `chat` itself. */
const ARGUMENTS: Record<string, Record<string, unknown>> = {
  signal_chat_read: { method: "view" },
  signal_file_save: { id: MESSAGE },
  signal_file_send: { files: [{ path: "note.txt" }] },
  signal_message_send: { text: "hello" },
  signal_message_edit: { id: MESSAGE, text: "changed" },
  signal_message_delete: { id: MESSAGE },
  signal_message_react: { id: MESSAGE, emoji: "👍" },
}

describe("chat exclusion gates", () => {
  test("the refusal is the error an unknown chat gets", () => {
    const t = createTestMirror()
    try {
      expect(() => existingChat(t.mirror, null, EXCLUDED)).toThrow(expect.objectContaining(UNKNOWN))
    } finally {
      t.close()
    }
  })

  for (const spec of ALL_TOOLS) {
    if (!("chat" in spec.input.shape)) continue

    test(`${spec.id} has a gate and arguments here`, () => {
      expect(spec.gate).toBeFunction()
      expect(ARGUMENTS[spec.id]).toBeDefined()
    })

    for (const chat of [EXCLUDED, EXCLUDED_GROUP]) {
      test(`${spec.id} refuses ${chat.slice(0, 8)} with the unknown-chat error, before anything runs`, async () => {
        const args = { ...ARGUMENTS[spec.id], chat }
        expect(spec.input.strict().safeParse(args).success).toBe(true)
        expect(await gateRefusal(spec, args, ctx)).toMatchObject(UNKNOWN)
        await expect(invoke(spec, args, ctx)).rejects.toMatchObject(UNKNOWN)
      })
    }

    test(`${spec.id} lets a chat that is not excluded through the gate`, async () => {
      expect(await gateRefusal(spec, { ...ARGUMENTS[spec.id], chat: OTHER }, ctx)).toBeUndefined()
    })

    test(`${spec.id} fails closed on a malformed setting without echoing it`, async () => {
      const malformed = withSetting(["private-secret"])
      const refusal = await gateRefusal(spec, { ...ARGUMENTS[spec.id], chat: OTHER }, malformed)
      expect(refusal?.code).toBe("invalid_argument")
      expect(refusal?.message).toContain("exclude_chats")
      expect(refusal?.message).not.toContain("private-secret")
    })
  }

  test.each(["view", "around", "search"])("chat read %s refuses an excluded chat", async (method) => {
    const args = {
      method,
      chat: EXCLUDED,
      ...(method === "around" ? { id: MESSAGE } : {}),
      ...(method === "search" ? { query: "hello" } : {}),
    }
    expect(await gateRefusal(signalChatRead, args, ctx)).toMatchObject(UNKNOWN)
  })

  test("chat read list and search across chats pass, but fail closed on a malformed setting", async () => {
    const malformed = withSetting([7 as unknown as string])
    for (const args of [{ method: "list" }, { method: "search", query: "hello" }]) {
      expect(await gateRefusal(signalChatRead, args, ctx)).toBeUndefined()
      expect(await gateRefusal(signalChatRead, args, malformed)).toMatchObject({ code: "invalid_argument" })
    }
  })

  test("a message id naming an excluded author is not refused", async () => {
    const args = { chat: OTHER, id: MESSAGE, emoji: "👍" }
    const react = ALL_TOOLS.find((spec) => spec.id === "signal_message_react")!
    expect(await gateRefusal(react, args, ctx)).toBeUndefined()
  })
})
