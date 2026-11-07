import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { ingestEnvelope } from "../signal/ingest"
import { labelPaths, type LabelPaths } from "../signal/labels"
import { inTransaction, openMirrorForWrite, setMeta, type Mirror } from "../signal/mirror"
import { ACCOUNT_UUID_META } from "../signal/mirror-meta"
import { ALICE, ME, NOW, dataFrom, makeTempDir } from "../signal/mirror.testing"
import { invoke, type ToolContext } from "../tool"
import type { FileSaveOutput } from "./schema"
import { createFileSave } from "./save"
import type { FileSaveHost } from "./save"

/** One attachment as signal-cli's receive output gives it. */
export type TestAttachment = { id?: string; contentType?: string; filename?: string }

/** A made-up sent time, and the id of the message an incoming one with that time has. */
export const SENT = 1_700_000_000_000
export const MESSAGE_ID = `${ALICE}:${SENT}`

/** An incoming message from Alice with files. */
export function messageWithFiles(sent: number, attachments: TestAttachment[], extra: Record<string, unknown> = {}) {
  return dataFrom(ALICE, sent, { message: "here you go", attachments, ...extra })
}

/** A linked label with a mirror, signal-cli's attachment store, a download directory and the tool. */
export type SaveFixture = {
  stateDir: string
  downloadDir: string
  paths: LabelPaths
  mirror: Mirror
  /** The folder of the message `MESSAGE_ID`. */
  folder: string
  /** The programs the fake runner was asked to run, in order. */
  runs: string[][]
  /** Ingests payloads, each in a transaction of its own, received at `NOW`. */
  ingest(...payloads: unknown[]): void
  /** Puts a file in the attachment store. */
  store(id: string, content: Uint8Array | string): string
  /** Puts a link in the attachment store. */
  storeLink(id: string, target: string): void
  /** Calls the tool; `host` replaces parts of the machine, `ctx` parts of the context. */
  save(
    args: Record<string, unknown>,
    options?: { host?: Partial<FileSaveHost>; ctx?: Partial<ToolContext> },
  ): Promise<FileSaveOutput>
  /** The error a call throws. */
  failure(args: Record<string, unknown>, options?: { ctx?: Partial<ToolContext> }): Promise<ToolError>
  close(): void
}

/** The arguments that save the message `MESSAGE_ID` of Alice's chat. */
export function saveArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { chat: ALICE, id: MESSAGE_ID, ...extra }
}

export function createSaveFixture(): SaveFixture {
  const stateDir = makeTempDir()
  const downloadDir = realpathSync(mkdtempSync(join(tmpdir(), "dl-")))
  const paths = labelPaths(stateDir, "default")
  mkdirSync(paths.attachments, { recursive: true })
  const mirror = openMirrorForWrite(paths.mirror)
  setMeta(mirror, { [ACCOUNT_UUID_META]: ME })
  const runs: string[][] = []
  const ok: ExecResult = { code: 0, stdout: "", stderr: "" }
  const context = (extra: Partial<ToolContext> = {}): ToolContext => ({
    cwd: stateDir,
    stateDir,
    downloadDir,
    programName: "signal-tools",
    ...extra,
  })
  const tool = (host: Partial<FileSaveHost> = {}) =>
    createFileSave({
      platform: "linux",
      run: async (argv) => {
        runs.push(argv)
        return ok
      },
      now: () => 1_700_000_123_000,
      uuid: () => "11111111-2222-4333-8444-555555555555".toUpperCase(),
      ...host,
    })
  const save: SaveFixture["save"] = (args, options = {}) => invoke(tool(options.host), args, context(options.ctx))
  return {
    stateDir,
    downloadDir,
    paths,
    mirror,
    folder: join(downloadDir, "default", `${SENT}-${ALICE}`),
    runs,
    ingest(...payloads) {
      for (const payload of payloads) {
        inTransaction(mirror, () =>
          ingestEnvelope(mirror, payload, { me: ME, attachmentsDir: paths.attachments, now: NOW }),
        )
      }
    },
    store(id, content) {
      const path = join(paths.attachments, id)
      writeFileSync(path, content)
      return path
    },
    storeLink(id, target) {
      symlinkSync(target, join(paths.attachments, id))
    },
    save,
    async failure(args, options = {}) {
      try {
        await invoke(tool(), args, context(options.ctx))
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    close() {
      mirror.close()
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(downloadDir, { recursive: true, force: true })
    },
  }
}

/** A signal that says "cancelled" from its `after`th check on; the tool checks before each file and each chunk it copies. */
export function abortAfter(after: number): AbortSignal {
  let checks = 0
  return abortWhen(() => ++checks > after)
}

/** A signal that says "cancelled" at the first check for which `when` holds. */
export function abortWhen(when: () => boolean): AbortSignal {
  return {
    throwIfAborted() {
      if (when()) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    },
  } as unknown as AbortSignal
}
