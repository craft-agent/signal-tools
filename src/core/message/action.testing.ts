import type { ToolError } from "../errors"
import { GROUP_PREFIX, isGroupChat } from "../signal/ids"
import { ALICE, sentTo, syncFromMe } from "../signal/mirror.testing"
import { invoke, type ToolContext } from "../tool"
import type { DeleteOutput, EditOutput, ReactOutput } from "./action-schema"
import { signalMessageDelete } from "./delete"
import { signalMessageEdit } from "./edit"
import { signalMessageReact } from "./react"
import { createSendFixture, SENT, type SendFixture } from "./send.testing"

/** The time the calls of an action test are made at, which the test sets the clock to: the sent time the fake daemon answers with. */
export const AT = SENT

/** The sent time of the user's own message to Alice that the action tests work on: a minute before `AT`. */
export const OWN = AT - 60_000

/** The data message of a reaction by the user, as a transcript from another device carries it. */
export function reactionData(author: string, ts: number, emoji: string, isRemove = false): Record<string, unknown> {
  return { reaction: { emoji, targetAuthorUuid: author, targetSentTimestamp: ts, isRemove } }
}

/** A label as `createSendFixture` makes it, and the actions to call. */
export type ActionFixture = SendFixture & {
  /** Calls `signal_message_edit`. */
  edit(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<EditOutput>
  /** The error `signal_message_edit` throws. */
  editFailure(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<ToolError>
  /** Calls `signal_message_delete`. */
  remove(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<DeleteOutput>
  /** The error `signal_message_delete` throws. */
  removeFailure(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<ToolError>
  /** Calls `signal_message_react`. */
  react(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<ReactOutput>
  /** The error `signal_message_react` throws. */
  reactFailure(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<ToolError>
  /** The parameters of the one request of `method` the daemon received. */
  requestParams(method: string): Record<string, unknown>
  /** Stores a message the user sent to `chat` at `ts`, as a transcript from another device does. */
  ownMessage(ts: number, message: Record<string, unknown>, chat?: string): void
  /** Stores an edit of the user's own message at `target`, made at `edited` on another device. */
  ownEdit(target: number, edited: number, text: string, chat?: string): void
}

/** The error a call throws. */
async function failureOf(call: Promise<unknown>): Promise<ToolError> {
  try {
    await call
  } catch (error) {
    if (error instanceof Error) return error as ToolError
    throw error
  }
  throw new Error("Expected the call to fail")
}

/** The sample label of the send tests. */
export function createActionFixture(): ActionFixture {
  const base = createSendFixture()
  const context = (ctx: Partial<ToolContext> = {}): ToolContext => ({
    cwd: base.stateDir,
    stateDir: base.stateDir,
    ...ctx,
  })
  return {
    ...base,
    edit: (args, ctx) => invoke(signalMessageEdit, args, context(ctx)),
    editFailure: (args, ctx) => failureOf(invoke(signalMessageEdit, args, context(ctx))),
    remove: (args, ctx) => invoke(signalMessageDelete, args, context(ctx)),
    removeFailure: (args, ctx) => failureOf(invoke(signalMessageDelete, args, context(ctx))),
    react: (args, ctx) => invoke(signalMessageReact, args, context(ctx)),
    reactFailure: (args, ctx) => failureOf(invoke(signalMessageReact, args, context(ctx))),
    requestParams(method) {
      const requests = base.daemon().calls.filter((call) => call.method === method)
      if (requests.length !== 1) throw new Error(`expected one ${method}, saw ${requests.length}`)
      return requests[0]!.params as Record<string, unknown>
    },
    ownMessage(ts, message, chat = ALICE) {
      const group = isGroupChat(chat)
        ? { groupInfo: { groupId: chat.slice(GROUP_PREFIX.length), type: "DELIVER" } }
        : {}
      base.ingest(sentTo(isGroupChat(chat) ? ALICE : chat, ts, { ...group, ...message }))
    },
    ownEdit(target, edited, text, chat = ALICE) {
      const group = isGroupChat(chat) ? { groupInfo: { groupId: chat.slice(GROUP_PREFIX.length) } } : {}
      const dataMessage = { timestamp: edited, message: text, ...group }
      base.ingest(
        syncFromMe({
          sentMessage: {
            destinationUuid: isGroupChat(chat) ? ALICE : chat,
            timestamp: edited,
            editMessage: { targetSentTimestamp: target, dataMessage },
          },
        }),
      )
    },
  }
}
