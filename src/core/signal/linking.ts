import { existsSync } from "node:fs"
import { lstat, rename, rm } from "node:fs/promises"
import { ToolError } from "../errors"
import { abortError } from "../exec"
import { readLinkedAccount } from "./account"
import { detail } from "./daemon-errors"
import { accountId } from "./ids"
import { ensureLabelDir, labelPaths, type LabelPaths } from "./labels"
import { ACCOUNT_UUID_META } from "./mirror-meta"
import { getMeta, openMirrorForRead, type Mirror } from "./mirror"
import { signalCliArgs, signalCliEnv, spawnSignalCli } from "./signal-cli"

/** How long a person has to scan the code. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** What the first line of standard output that carries the link starts with. */
const LINK_URI_PREFIX = "sgnl://linkdevice?"

/** The name the phone lists the device under: 1 to 50 characters, none of them a control character. */
const MAX_DEVICE_NAME_LENGTH = 50
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/

/** How many of signal-cli's last lines of standard error an error carries. */
const ERROR_LOG_LINES = 5

const STILL_LINKED =
  "This label is still linked. To link it again, remove this device on the phone (Settings > Linked devices) first, or remove the label."
const NOT_FINISHED = "Linking did not finish."
const NOT_SCANNED = "No phone scanned the code in time; run the link again."
const OTHER_ACCOUNT =
  "The phone that scanned the code holds a different account than this label's history. Remove this device from that phone's Linked devices, then link it under another label."

export type LinkOptions = {
  stateDir: string
  label: string
  /** The name the phone lists the new device under. */
  deviceName: string
  /** The signal-cli executable. */
  program: string
  /** Where `signalCliEnv` takes signal-cli's environment from. */
  env: Record<string, string | undefined>
  /** Receives the `sgnl://linkdevice?...` address the phone scans, once. */
  onLinkUri(uri: string): void
  /** Receives signal-cli's standard error, line by line, with phone numbers masked. */
  log?(line: string): void
  /** Stops signal-cli and rejects with an `AbortError` when it aborts. */
  signal?: AbortSignal
  /** How long the phone has to scan the code; 10 minutes by default. */
  timeoutMs?: number
}

export type LinkResult = {
  label: string
  /** Where the keys of the label's earlier, unlinked device were moved to. */
  movedAside?: string
}

function checkDeviceName(deviceName: string): void {
  const length = Array.from(deviceName).length
  if (length < 1 || length > MAX_DEVICE_NAME_LENGTH || CONTROL_CHARACTER.test(deviceName)) {
    throw new ToolError(
      "invalid_argument",
      `The device name must be 1 to ${MAX_DEVICE_NAME_LENGTH} characters without control characters.`,
    )
  }
}

/** The local time as `YYYYMMDDHHmmss`. */
function timestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0")
  return (
    String(date.getFullYear()) +
    two(date.getMonth() + 1) +
    two(date.getDate()) +
    two(date.getHours()) +
    two(date.getMinutes()) +
    two(date.getSeconds())
  )
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

/** Moves signal-cli's directory of an unlinked device out of the way and returns where it went to. */
async function moveAside(paths: LabelPaths): Promise<string> {
  const base = `${paths.signalCli}.unlinked-${timestamp(new Date())}`
  let target = base
  for (let attempt = 2; await exists(target); attempt++) target = `${base}-${attempt}`
  await rename(paths.signalCli, target)
  return target
}

/**
 * The account id the label's mirror holds history for, or null when there is
 * no mirror, it was never set up, or it names none. Any other failure to read
 * the mirror propagates: linking must not guess.
 */
function historyAccount(paths: LabelPaths): string | null {
  if (!existsSync(paths.mirror)) return null
  let mirror: Mirror
  try {
    mirror = openMirrorForRead(paths.mirror)
  } catch (error) {
    if (error instanceof ToolError && error.code === "not_found") return null
    throw error
  }
  try {
    return accountId(getMeta(mirror)[ACCOUNT_UUID_META])
  } finally {
    mirror.close()
  }
}

/** Refuses a label that is still linked; moves an unlinked device's keys aside and returns where to, if there were any. */
async function prepareLabel(paths: LabelPaths): Promise<string | undefined> {
  const account = readLinkedAccount(paths)
  if (account === null) return undefined
  if (account.registered !== false) throw new ToolError("invalid_argument", STILL_LINKED)
  return moveAside(paths)
}

/** Checks that the scan finished and belongs to the label's history; removes the new keys when it does not. */
async function verifyLinked(paths: LabelPaths): Promise<void> {
  const account = readLinkedAccount(paths)
  if (account?.registered !== true) throw new ToolError("upstream_error", NOT_FINISHED)
  const history = historyAccount(paths)
  if (history !== null && history !== account.uuid) {
    await rm(paths.signalCli, { recursive: true, force: true })
    throw new ToolError("invalid_argument", OTHER_ACCOUNT)
  }
}

/** Runs `signal-cli link` in the label's directory and checks what it left there; signal-cli has ended when this settles. */
async function runLink(options: LinkOptions, paths: LabelPaths): Promise<LinkResult> {
  const { label, deviceName, program, env, onLinkUri, log, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const movedAside = await prepareLabel(paths)

  let linkUriSent = false
  const stderrTail: string[] = []
  const child = spawnSignalCli(program, signalCliArgs(paths, "link", "-n", deviceName), {
    env: signalCliEnv(env),
    onStdoutLine(line) {
      if (linkUriSent || !line.startsWith(LINK_URI_PREFIX)) return
      linkUriSent = true
      onLinkUri(line)
    },
    onStderrLine(line) {
      stderrTail.push(line)
      if (stderrTail.length > ERROR_LOG_LINES) stderrTail.shift()
      log?.(line)
    },
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<"timeout" | "abort">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
    onAbort = () => resolve("abort")
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })

  try {
    const outcome = await Promise.race([child.exited, interrupted])
    if (outcome === "abort") throw abortError(signal!)
    if (outcome === "timeout") throw new ToolError("upstream_error", NOT_SCANNED)
    if (outcome.code !== 0) {
      const reason = detail(stderrTail.join(" "))
      throw new ToolError("upstream_error", `signal-cli could not link the device${reason || "."}`)
    }
    await verifyLinked(paths)
    return { label, ...(movedAside === undefined ? {} : { movedAside }) }
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
    await child.stop()
  }
}

/**
 * Links this machine as a device of the person's phone under a label.
 *
 * Runs `signal-cli link`, hands the address the phone scans to `onLinkUri`
 * and waits for the scan. A label whose device Signal unlinked has its old
 * keys moved aside (its mirror stays); one that is still linked is refused.
 * A scan by a phone whose account differs from the one the label's mirror
 * holds removes the new keys again. signal-cli never outlives the call, and a
 * label directory this call created does not outlive a failure of it.
 */
export async function linkDevice(options: LinkOptions): Promise<LinkResult> {
  const { stateDir, label, deviceName, signal } = options
  if (signal?.aborted) throw abortError(signal)
  const { dir } = labelPaths(stateDir, label)
  checkDeviceName(deviceName)
  const created = !(await exists(dir))
  const paths = await ensureLabelDir(stateDir, label)
  try {
    return await runLink(options, paths)
  } catch (error) {
    // Only what this call and signal-cli wrote can be in a directory this call created.
    if (created) await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
