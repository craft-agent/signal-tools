import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createSendFixture, type SendFixture } from "../../message/send.testing"
import { invoke, type ToolContext } from "../../tool"
import type { ToolError } from "../../errors"
import { signalFileSend } from "./tool"
import type { FileSendOutput } from "./schema"

/** Makes a FIFO at `path`; throws where the machine has no `mkfifo`. */
export function makeFifo(path: string): void {
  execFileSync("mkfifo", [path])
}

/** Whether this machine has `mkfifo` and lets a test make a FIFO. */
export function canMakeFifo(): boolean {
  const probe = join(tmpdir(), `fifo-probe-${process.pid}`)
  try {
    makeFifo(probe)
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { force: true })
  }
}

/** The files a call sends, as the fake daemon saw them while the call was open. */
export type SeenAttachment = { path: string; content: Buffer; mode: number; folderMode: number }

/** A test fixture for sending files to a fake daemon and mirror. */
export type FileSendFixture = Omit<SendFixture, "send" | "sendFailure"> & {
  /** The working directory the calls run in (a real path). */
  work: string
  /** Writes a file below the working directory and returns its path. */
  write(path: string, content?: string | Uint8Array): string
  /** Calls the tool; `tool` replaces it, for one made with other limits. */
  sendFiles(
    args: Record<string, unknown>,
    ctx?: Partial<ToolContext>,
    tool?: typeof signalFileSend,
  ): Promise<FileSendOutput>
  /** The error a call throws. */
  filesFailure(
    args: Record<string, unknown>,
    ctx?: Partial<ToolContext>,
    tool?: typeof signalFileSend,
  ): Promise<ToolError>
  /** The names in the label's outbox: the folders of calls that are still there. */
  outboxEntries(): string[]
  /** How many sends the fake daemon received. */
  sends(): number
  /** Serves a send that is accepted, noting the attachments as the daemon sees them while the call is open. */
  serveAndSee(answer: Parameters<SendFixture["serve"]>[0]): Promise<SeenAttachment[]>
}

/** A label with the sample chats, a fake daemon to serve, and a working directory to send files from. */
export function createFileSendFixture(): FileSendFixture {
  const base = createSendFixture()
  const work = realpathSync(mkdtempSync(join(tmpdir(), "send-work-")))
  const run = (args: Record<string, unknown>, ctx: Partial<ToolContext> = {}, tool = signalFileSend) =>
    invoke(tool, args, { cwd: work, stateDir: base.stateDir, ...ctx })
  const { send: _send, sendFailure: _sendFailure, ...rest } = base
  return {
    ...rest,
    work,
    write(path, content = "made-up content\n") {
      const full = join(work, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
      return full
    },
    sendFiles: run,
    async filesFailure(args, ctx, tool) {
      try {
        await run(args, ctx, tool)
      } catch (error) {
        if (error instanceof Error) return error as ToolError
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    outboxEntries: () => (existsSync(base.paths.outbox) ? readdirSync(base.paths.outbox) : []),
    sends: () => base.daemon().calls.filter((call) => call.method === "send").length,
    async serveAndSee(answer) {
      const seen: SeenAttachment[] = []
      await base.serve(async (method, params) => {
        if (method === "send") {
          const { attachment = [] } = params as { attachment?: string[] }
          for (const path of attachment) {
            seen.push({
              path,
              content: readFileSync(path),
              mode: modeOf(path),
              folderMode: modeOf(dirname(path)),
            })
          }
        }
        return typeof answer === "function" ? answer(method, params) : answer
      })
      return seen
    },
    async close() {
      await base.close()
      rmSync(work, { recursive: true, force: true })
    },
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}
