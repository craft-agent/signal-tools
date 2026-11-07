import { existsSync } from "node:fs"
import { rm, statfs } from "node:fs/promises"
import { readLinkedAccount } from "./account"
import { DaemonConnection } from "./daemon"
import { accountId } from "./ids"
import { labelPaths, type LabelPaths } from "./labels"
import { ACCOUNT_UUID_META } from "./mirror-meta"
import { getMeta, inTransaction, openMirrorForWrite, setMeta, type Mirror } from "./mirror"
import type { SignalCliExit } from "./signal-cli"
import { connectWhenReady, removeDaemonFiles, startDaemon, stopStaleDaemon, type Daemon } from "./sync-daemon"
import { Ending, type Ended } from "./sync-ending"
import { RPC_TIMEOUT_MS, resolveOptions, type ResolvedSyncOptions, type SyncOptions } from "./sync-options"
import { UNLINKED_REASON, settle } from "./sync-outcome"
import { LOCK_HELD_REASON, acquireSyncLock } from "./sync-lock"
import { Receiver, STORAGE_FAILURE_REASON } from "./sync-receive"
import { refreshDirectory } from "./sync-refresh"
import {
  ERROR_META,
  NOT_LINKED_MESSAGE,
  STARTED_AT_META,
  STATUS_META,
  SUBSCRIBED_AT_META,
  errorText,
  recordStatus,
  recordStatusAlone,
  type SyncOutcome,
} from "./sync-status"
import { Wakeup, onAbort, settledOrTimeout, sleep } from "./sync-wait"

export type { SyncOptions } from "./sync-options"
export type { SyncOutcome } from "./sync-status"

const NOT_LINKED_OUTCOME: SyncOutcome = { exitCode: 0, status: "not linked" }
const DISK_FULL_REASON = "the disk is nearly full; not receiving until there is room"
const OTHER_ACCOUNT_REASON = "this label's history belongs to another account"
const NO_ACCOUNT_ID_REASON = "signal-cli has not recorded this account's id yet"

/** What one run works on. */
type Run = {
  mirror: Mirror
  paths: LabelPaths
  /** The account's number, for signal-cli's `-a` only. */
  number: string
  /** The account's own id. */
  me: string
  settings: ResolvedSyncOptions
}

/** What a run has started so far, for its end to stop. */
type Session = { daemon?: Daemon; connection?: DaemonConnection; storageFailed?: true }

/** The free bytes of the file system holding `dir`, or undefined when it cannot be told. */
async function freeBytes(dir: string): Promise<number | undefined> {
  try {
    const stats = await statfs(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return undefined
  }
}

/** Records the failure in the mirror, as far as it can be written, and returns it as the outcome. */
function failed(mirror: Mirror, log: (line: string) => void, reason: string): SyncOutcome {
  try {
    recordStatus(mirror, "failed", reason)
  } catch {
    // A mirror that cannot be written cannot say so; the log and the outcome do.
  }
  log(reason)
  return { exitCode: 1, status: "failed", reason }
}

/** Subscribes, then keeps the mirror current until something ends receiving; resolves with what did. */
async function receive(run: Run, session: Session, daemon: Daemon, connection: DaemonConnection): Promise<Ended> {
  const { mirror, paths, me, settings } = run
  const { log, now } = settings
  const ending = new Ending()
  const wakeup = new Wakeup()
  const stopListening = onAbort(settings.signal, () => ending.end({ kind: "stop" }))
  void daemon.ended.then(() => ending.end({ kind: "child" }))
  void connection.closed.then(() => ending.end({ kind: "connection" }))

  const receiver = new Receiver({
    mirror,
    me,
    attachmentsDir: paths.attachments,
    now,
    log,
    onGroupsStale: () => wakeup.notify(),
    onStorageFailure() {
      // Remembered whatever ended receiving first: a failure while draining after a stop still fails the run.
      session.storageFailed = true
      // The daemon first: every envelope it hands on from here is lost to the mirror.
      ending.end({ kind: "storage", reason: STORAGE_FAILURE_REASON })
      void daemon.stop()
      connection.close()
    },
  })
  // Before subscribing, so no envelope emitted right after the answer is missed.
  connection.onNotification(receiver.handle)

  try {
    try {
      await connection.call("subscribeReceive", undefined, { timeoutMs: RPC_TIMEOUT_MS, signal: ending.signal })
    } catch (error) {
      ending.end({ kind: "error", reason: errorText(error) })
      return await ending.promise
    }
    await receiver.guard(() =>
      inTransaction(mirror, () => setMeta(mirror, { [STATUS_META]: "running", [SUBSCRIBED_AT_META]: now() })),
    )
    log("subscribed")

    while (!ending.settled) {
      wakeup.clear()
      await receiver.guard(() =>
        refreshDirectory({
          connection,
          mirror,
          now,
          log,
          signal: ending.signal,
          groupsUnchanged: () => !wakeup.notified,
        }),
      )
      if (ending.settled) break
      await wakeup.wait(settings.refreshEveryMs, ending.promise)
    }
    return await ending.promise
  } finally {
    stopListening()
  }
}

/** Starts the daemon and receives from it; resolves with what ended it, having started whatever `session` records. */
async function runDaemon(run: Run, session: Session): Promise<Ended> {
  const { paths, number, settings } = run
  session.daemon = await startDaemon({
    program: settings.program,
    env: settings.env,
    paths,
    number,
    log: settings.log,
    stopGraceMs: settings.stopGraceMs,
  })
  const connection = await connectWhenReady(session.daemon, paths.socket, settings.socketWaitMs, settings.signal)
  if (!(connection instanceof DaemonConnection)) return connection
  session.connection = connection
  return receive(run, session, session.daemon, connection)
}

/**
 * Stops the daemon, stores what is still arriving until the connection
 * closes (or `drainMs` passes), closes the connection and removes the
 * daemon's files. Returns how the daemon had exited by itself, if it had.
 */
async function shutDown(run: Run, { daemon, connection }: Session, ended: Ended): Promise<SignalCliExit | undefined> {
  const { paths, settings } = run
  // A connection that closed first usually means the daemon is exiting; its exit code says why.
  if (daemon && ended.kind === "connection") await settledOrTimeout(daemon.ended, settings.drainMs)
  const exit = daemon?.exit
  await daemon?.stop()
  if (connection) {
    if (ended.kind !== "storage") await settledOrTimeout(connection.closed, settings.drainMs)
    connection.close()
  }
  await removeDaemonFiles(paths)
  return exit
}

/** Everything from starting the daemon to the outcome, with the mirror open and the account checked. */
async function syncWithMirror(run: Run): Promise<SyncOutcome> {
  const { mirror, paths, settings } = run
  const session: Session = {}
  let ended: Ended
  try {
    await rm(paths.socket, { force: true })
    ended = settings.signal?.aborted ? { kind: "stop" } : await runDaemon(run, session)
  } catch (error) {
    ended = { kind: "error", reason: errorText(error) }
  }
  const exit = await shutDown(run, session, ended)
  // A mirror that could not be written fails the run even when a stop request came first.
  if (session.storageFailed) ended = { kind: "storage", reason: STORAGE_FAILURE_REASON }
  const { daemon } = session
  const settled = settle({ ended, paths, exit, startError: daemon?.startError, tail: daemon?.tail ?? [] })
  try {
    recordStatus(mirror, settled.status, settled.error)
  } catch {
    // See `failed`.
  }
  settings.log(settled.message)
  return settled.outcome
}

/** The checks that need the label's lock, then the run itself. */
async function syncLocked(paths: LabelPaths, settings: ResolvedSyncOptions): Promise<SyncOutcome> {
  const { log } = settings
  const account = readLinkedAccount(paths)
  if (account === null) {
    log(NOT_LINKED_MESSAGE)
    return NOT_LINKED_OUTCOME
  }
  if (account.registered === false) {
    if (existsSync(paths.mirror)) recordStatusAlone(paths.mirror, "unlinked", UNLINKED_REASON)
    log("this device is no longer linked; link it again")
    return { exitCode: 0, status: "unlinked", reason: UNLINKED_REASON }
  }

  const free = await freeBytes(paths.dir)
  if (free !== undefined && free < settings.minFreeBytes) {
    recordStatusAlone(paths.mirror, "failed", DISK_FULL_REASON)
    log(DISK_FULL_REASON)
    await sleep(settings.diskWaitMs, settings.signal)
    return { exitCode: 1, status: "failed", reason: DISK_FULL_REASON }
  }

  const mirror = openMirrorForWrite(paths.mirror)
  try {
    const { uuid: me, number } = account
    if (me === null) return failed(mirror, log, NO_ACCOUNT_ID_REASON)
    const history = getMeta(mirror)[ACCOUNT_UUID_META]
    if (history !== undefined && accountId(history) !== me) return failed(mirror, log, OTHER_ACCOUNT_REASON)
    inTransaction(mirror, () =>
      setMeta(mirror, {
        [ACCOUNT_UUID_META]: me,
        [STATUS_META]: "starting",
        [STARTED_AT_META]: settings.now(),
        [SUBSCRIBED_AT_META]: null,
        [ERROR_META]: null,
      }),
    )
    log("starting")
    return await syncWithMirror({ mirror, paths, number, me, settings })
  } finally {
    mirror.close()
  }
}

/**
 * Keeps one label's mirror current: runs the label's signal-cli daemon as a
 * child with manual receiving, subscribes, and stores every envelope.
 *
 * One run per label: it holds the label's lock for as long as it runs, and a
 * second run resolves as `failed` at once, touching nothing. A daemon left
 * by an earlier run is stopped before anything else is decided.
 *
 * Resolves once receiving ended, with nothing left running: no daemon, timer
 * or listener, and its socket and pid file removed. A stop request resolves
 * as `stopped` (exit code 0), as do a label with no linked account and a
 * device Signal unlinked, which need a new link before anything can run;
 * every other end is `failed` (exit code 1). A mirror that cannot be written
 * stops receiving at once and fails the run, whatever else ended it.
 */
export async function runSync(options: SyncOptions): Promise<SyncOutcome> {
  const settings = resolveOptions(options)
  const { log } = settings
  const paths = labelPaths(settings.stateDir, settings.label)
  if (!existsSync(paths.dir)) {
    log(NOT_LINKED_MESSAGE)
    return NOT_LINKED_OUTCOME
  }

  const release = acquireSyncLock(paths.syncLock)
  if (!release) {
    log(LOCK_HELD_REASON)
    return { exitCode: 1, status: "failed", reason: LOCK_HELD_REASON }
  }
  try {
    await stopStaleDaemon(paths, settings.stopGraceMs, log)
    return await syncLocked(paths, settings)
  } finally {
    release()
  }
}
