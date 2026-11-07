import { rmSync, symlinkSync } from "node:fs"
import type { ToolError } from "../errors"
import { createChatFixture, fillSampleChats, type ChatFixture } from "../chat/read.testing"
import { startFakeDaemon, type FakeDaemon, type FakeReply } from "../signal/daemon.testing"
import { labelPaths, type LabelPaths } from "../signal/labels"
import { invoke, type ToolContext } from "../tool"
import { signalMessageSend } from "./send"
import type { SendOutput } from "./schema"

/** The sent time the fake daemon answers with. */
export const SENT = 1_800_000_100_000

/** What the fake daemon answers a send with: the sent time and one result per recipient. */
export type FakeAnswer = (method: string, params: unknown) => FakeReply | Promise<FakeReply>

/** A recipient's result as signal-cli writes it. */
export function recipientResult(uuid: string, type = "SUCCESS", extra: Record<string, unknown> = {}) {
  return { recipientAddress: { uuid, number: "+15555550999" }, type, ...extra }
}

/** The answer of a send that reached `recipients`. */
export function accepted(...recipients: string[]): FakeReply {
  return { result: { timestamp: SENT, results: recipients.map((uuid) => recipientResult(uuid)) } }
}

/** A send that failed as a call, carrying its per-recipient results as signal-cli does. */
export function failedEverywhere(code: number, ...results: ReturnType<typeof recipientResult>[]): FakeReply {
  return { error: { code, message: "Failed to send", data: { response: { timestamp: SENT, results } } } }
}

export type SendFixture = Omit<ChatFixture, "close"> & {
  paths: LabelPaths
  daemon(): FakeDaemon
  /** Starts the fake daemon on the label's socket, replacing the one running. */
  serve(answer: FakeReply | FakeAnswer): Promise<FakeDaemon>
  /** Calls the tool. */
  send(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<SendOutput>
  /** The error a call throws. */
  sendFailure(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<ToolError>
  /** The parameters of the one send the daemon received. */
  sentParams(): Record<string, unknown>
  /** Stops the fake daemon and removes the state directory. */
  close(): Promise<void>
}

/** A label with the sample chats of the chat tests in its mirror, and a fake daemon to serve once a test starts it. */
export function createSendFixture(): SendFixture {
  const chats = createChatFixture()
  fillSampleChats(chats)
  const paths = labelPaths(chats.stateDir, "default")
  let fake: FakeDaemon | undefined
  const run = (args: Record<string, unknown>, ctx: Partial<ToolContext> = {}) =>
    invoke(signalMessageSend, args, { cwd: chats.stateDir, stateDir: chats.stateDir, ...ctx })
  const daemon = () => {
    if (!fake) throw new Error("the fake daemon was not started")
    return fake
  }
  return {
    ...chats,
    paths,
    daemon,
    async serve(answer) {
      if (fake) {
        await fake.close()
        rmSync(paths.socket)
      }
      fake = await startFakeDaemon(typeof answer === "function" ? answer : () => answer)
      symlinkSync(fake.socketPath, paths.socket)
      return fake
    },
    send: run,
    async sendFailure(args, ctx) {
      try {
        await run(args, ctx)
      } catch (error) {
        if (error instanceof Error) return error as ToolError
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    sentParams() {
      const sends = daemon().calls.filter((call) => call.method === "send")
      if (sends.length !== 1) throw new Error(`expected one send, saw ${sends.length}`)
      return sends[0]!.params as Record<string, unknown>
    },
    async close() {
      await fake?.close()
      chats.close()
    },
  }
}
